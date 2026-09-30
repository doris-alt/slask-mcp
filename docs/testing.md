# Testing

`cargo test` runs the integration suite in `tests/` (plus any unit tests
in the crate — none exist at this snapshot).

## Coverage

`tests/http_integration.rs` contains **14 integration tests** that drive
the **real** router built by `new_http_stack(auth)` — the actual auth
middleware plus the rmcp `StreamableHttpService` — with **no sockets**.
An axum `Router` is a tower `Service`, so each test builds a `Request`,
calls `app.call(req).await`, and inspects the `Response`.

### Auth disabled (`AuthConfig { token: None }`)

| #  | Test                                                     | Asserts                                                                |
| -- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1  | `initialize_returns_server_info_when_auth_disabled`      | success status, `serverInfo.name == "slask-mcp"`                       |
| 2  | `tools_list_works_without_auth`                          | success status, tool names present                                     |
| 3  | `echo_returns_message_when_auth_disabled`                | success status, echoed text, `isError: false`                          |
| 4  | `current_time_utc_is_rfc3339_utc_when_auth_disabled`     | success status, valid RFC 3339 timestamp, UTC, within one week of now  |
| 5  | `search_tools_returns_all_tools_sorted_for_empty_query`  | `structuredContent.total == 3`, all tools present and name-sorted      |
| 6  | `search_tools_matches_name_case_insensitive`             | only `echo` matched for query `"ECHO"`                                 |
| 7  | `search_tools_matches_description_substring`             | only `echo` matched via its description (no name match)                |

### Auth enabled (`AuthConfig { token: Some(...) }`)

| #   | Test                                                      | Asserts                                                                                                                                     |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 8   | `missing_authorization_header_is_401`                     | 401 + `WWW-Authenticate: Bearer realm="mcp"` + JSON `{"error":"Unauthorized","detail":"Missing or invalid Authorization: Bearer header."}`  |
| 9   | `wrong_bearer_token_is_401`                               | 401                                                                                                                                         |
| 10  | `initialize_is_401_without_authorization_when_token_set`  | 401 (auth applies to the handshake too)                                                                                                     |
| 11  | `tools_list_allowed_with_correct_bearer`                  | success status, tools listed                                                                                                                |
| 12  | `echo_allowed_with_correct_bearer`                        | success status, text echoed                                                                                                                 |
| 13  | `correct_bearer_with_lowercase_scheme_is_allowed`         | success status (scheme match is case-insensitive)                                                                                           |

### Request size limits

| #   | Test                             | Asserts                                                                                                    |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 14  | `payload_too_large_is_rejected`  | 413 `Payload Too Large` for a > 1 MiB body (auth enabled with a correct Bearer; a 1.2 MiB `echo` payload)  |

## How it works

- **`rpc_request(body, auth)`** — builds a `POST /mcp` with
  `Content-Type: application/json`, `Accept: application/json,
  text/event-stream`, and an explicit `Host: 127.0.0.1`. `Host` is needed
  because rmcp validates it (DNS-rebinding protection) and there is no TCP
  connection to supply one.
- **`send(app, body, auth)`** — `app.call(...).await`. The import must be
  `tower::Service` (its `call` method) — **not** `tower::ServiceExt`.
- **`json_body(res)`** — `axum::body::to_bytes(res.into_body(), usize::MAX)`
  then `serde_json::from_slice`. `Body` is not `Clone` and is consumed by
  `to_bytes`, so pass `res.into_body()`, not `res.body()`.
- **`search_matched_names(body)`** — reads
  `result.structuredContent.matched` for `search_tools` replies: that tool
  returns structured output, so its names live in `structuredContent`, not
  `content` like the text tools.

## Gotchas this suite ran into

Worth remembering when adding tests (see also the axum 0.8 / chrono
notes in the repo's project memory):

- `StatusCode` has `.is_success()` — there is no `.is_ok()`.
- `axum::body::Body::from(...)` needs an owned value (`String`, `Vec<u8>`);
  a `&str` does not work directly.
- chrono 0.4.45: `FixedOffset` has no `is_utc()` — check
  `dt.naive_utc() == dt.naive_local()` instead. Duration math:
  `dt.signed_duration_since(&ref)` returns a `chrono::TimeDelta`
  (`chrono::Duration` is a deprecated alias for it).
- axum `.layer()` applies only to routes that already exist at the call
  site — `new_http_stack` calls `nest_service` **before** `.layer()`.

## Ideas for more tests

- `tools/call` with an unknown tool name → assert the JSON-RPC error.
- `initialize` over HTTP without `clientInfo` → JSON-RPC error `-32602`.
- SSE path: rebuild the service with `with_json_response(false)` and parse
  a server-sent-events body instead of plain JSON.
- Graceful shutdown: cancel the returned `CancellationToken` mid-request.
- Legacy session mode (`legacy_session_mode(true)`) flow.
