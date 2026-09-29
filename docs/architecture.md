# Architecture

slask-mcp is a single cargo package with **two crates**:

| Crate | Path | Responsibility |
|---|---|---|
| Library `slask_mcp` | `src/lib.rs` | All server logic: tools, auth, stack construction |
| Binary | `src/main.rs` | CLI flag selection, logging setup, TCP listener, graceful shutdown |

Splitting the logic into the library crate is what lets the integration
tests in `tests/` drive the *real* router without sockets.

## Project layout

```
src/
  lib.rs                 # tools, auth, new_http_stack, serve_stdio
  main.rs                # thin binary (stdio by default, `--http` flag)
tests/
  http_integration.rs    # 10 integration tests (no sockets)
```

## Key abstractions

### `SlaskTools`

Tools are declared on one type via rmcp's `#[tool_router]` macro
([`src/lib.rs`](../src/lib.rs)):

- `echo(message: String) -> String`
- `current_time_utc() -> String`

The `#[tool_handler(name = "slask-mcp", instructions = "...")]` attribute on
`impl ServerHandler for SlaskTools` auto-generates `call_tool`,
`list_tools`, `get_tool`, and `get_info()` — an empty impl body is enough.
Tool names, descriptions, and input schemas come from the attributes, so
`tools/list` always matches the implementation.

### `AuthConfig`

`pub struct AuthConfig { pub token: Option<String> }`.

- `token == None` → HTTP transport open.
- `token == Some(t)` → every HTTP request must carry `Authorization: Bearer t`.

See [authentication](authentication.md) for behaviour details.

### `new_http_stack(auth) -> (Router, CancellationToken)`

Builds the streamable-HTTP stack in three steps:

1. A `StreamableHttpService` (rmcp) with a `LocalSessionManager`,
   configured stateless (`legacy_session_mode(false)`) and with plain JSON
   replies (`with_json_response(true)`).
2. Nest it at `/mcp`: `Router::new().nest_service("/mcp", service)`.
3. Apply the auth middleware **after** the routes exist:
   `.layer(from_fn_with_state(auth, auth_middleware))`.

   This order matters: axum applies `.layer()` only to routes that already
   exist at the call site.

It also creates a `CancellationToken`, hands a child token to the rmcp
service via `with_cancellation_token`, and returns the token for graceful
shutdown.

### `serve_stdio()`

`SlaskTools {}.serve(stdio()).await`, then `.waiting()` — blocks until stdin
is closed.

### Auth internals

- `has_bearer(headers, token)` — the scheme is matched case-insensitively
  (`eq_ignore_ascii_case("bearer")`); the token is compared in constant time
  (length checked first, byte loop never short-circuits: `ok &= x == y`).
- `unauthorized_response()` — a 401 with
  `WWW-Authenticate: Bearer realm="mcp"` and a JSON error body (per the MCP
  spec, so clients know the endpoint wants a Bearer token).
- `auth_middleware` — axum middleware that short-circuits to the 401 when a
  token is configured and the header is missing or invalid.

## HTTP request pipeline

```
POST /mcp
  → axum Router
      └─ auth middleware (State<AuthConfig>)      [401 or pass through]
          └─ rmcp StreamableHttpService           [JSON-RPC ↔ HTTP]
              └─ SlaskTools (ServerHandler)       [echo / current_time_utc]
```

## Sessions

`LocalSessionManager` + `legacy_session_mode(false)` means the transport is
**stateless**: there is no per-client session state and no session ID to
carry between requests. Every request is self-contained — even `tools/list`
and `tools/call` work without a prior `initialize` (the integration tests do
exactly that).

## Graceful shutdown

`new_http_stack` returns a `CancellationToken`. On SIGINT, the binary
cancels it; the rmcp service cancels its in-flight handlers and axum's
`axum::serve(...).with_graceful_shutdown(...)` stops accepting new
connections.

## Logging

tracing + tracing-subscriber:

- Filter: the `RUST_LOG` environment variable, defaulting to `info` when unset.
- Writer: always **stderr** — so stdout stays pure JSON-RPC in stdio mode.
- ANSI disabled (`with_ansi(false)`), since stderr is often a pipe.

## Dependencies

| Dependency | Version | Role |
|---|---|---|
| rmcp | 3.5.0 | MCP protocol + both transports (`transport-io`, `transport-streamable-http-server`) |
| axum | 0.8 | HTTP router, middleware, `Body` |
| tokio | 1 (`full`) | async runtime, TCP listener, signals |
| tokio-util | 0.7 | `CancellationToken` |
| chrono | 0.4 | `Utc::now()` for `current_time_utc` |
| serde / serde_json / schemars | 1 | JSON-RPC, schema generation |
| anyhow | 1 | error propagation |
| tracing / tracing-subscriber | 0.1 / 0.3 | logging |
| dotenvy | 0.15 | loads `.env` (HTTP mode only) |
| tower | 0.5 (dev) | `Router::call` in the integration tests |
