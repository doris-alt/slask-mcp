# Streamable HTTP transport

Start it with the `--http` flag:

```bash
./target/release/slask-mcp --http   # or: cargo run -- --http
```

It listens at `$SLASK_MCP_BIND:$SLASK_MCP_PORT` (defaults
`127.0.0.1:8000`) and exposes a single endpoint: **`POST /mcp`**. Every
MCP message (`initialize`, `tools/list`, `tools/call`) goes to that one URL
as a JSON-RPC body — see [stdio](stdio.md) for the message shapes.

## Required headers

| Header           | Value                                  | Note                                                                          |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `Content-Type`   | `application/json`                     | JSON-RPC body                                                                 |
| `Accept`         | `application/json, text/event-stream`  | required — 406 if missing                                                     |
| `Authorization`  | `Bearer <token>`                       | only when `SLASK_MCP_TOKEN` is set — see [authentication](authentication.md)  |

**`Host`** — rmcp enforces DNS-rebinding protection and validates the
`Host` header (notably on `initialize`). Over a real connection the
client's `Host` header is used as-is; when driving the router in-process
(with no TCP connection) you must set it explicitly, e.g. `Host: 127.0.0.1`
(the integration tests do this). If you put a reverse proxy in front of
the server, preserve the `Host` header.

## Response format

The service is configured with `with_json_response(true)`, so replies are
**plain JSON** objects with `Content-Type: application/json` rather than
server-sent events. With `with_json_response(false)` rmcp would use SSE
instead.

## Request limits

Two baseplate limits protect the server from oversized or hung clients
(both run in middleware, **before** the rmcp handler):

- **Body size — 1 MiB.** Every request body is read with a 1 MiB cap
  (`axum::body::to_bytes`). Over the limit the server returns `413 Payload
  Too Large`:
  ```json
  {"error":"PayloadTooLarge","detail":"Request body exceeded 1 MiB."}
  ```
- **Request duration — 10 s.** Each request is wrapped in a 10-second
  timeout. A hung handler that exceeds it is cut off with `504 Gateway
  Timeout`:
  ```json
  {"error":"Timeout","detail":"Request execution exceeded 10 seconds."}
  ```

The timeout timer covers the body read plus the rmcp handler execution, and
auth runs first (so a missing token is a `401` before any body work).

## Examples

Terminal 1 — start the server (token unset, so no `Authorization` header
needed):

```bash
SLASK_MCP_PORT=9000 cargo run -- --http
```

Terminal 2 — talk to it:

```bash
# initialize (must include clientInfo)
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'

# tools/list
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# tools/call: echo
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}'

# tools/call: current_time_utc
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"current_time_utc","arguments":{}}}'
```

When `SLASK_MCP_TOKEN` is set, add
`-H "Authorization: Bearer $SLASK_MCP_TOKEN"` to each request.

## Sessions

The transport runs with `legacy_session_mode(false)` — **stateless**: there
is no per-client session state and no session ID to carry between requests.
Every request is self-contained; even `tools/list` and `tools/call` work
without a prior `initialize` (the integration tests do exactly that).

## Graceful shutdown

Ctrl+C (SIGINT) cancels the stack's `CancellationToken`, which cancels the
rmcp service (in-flight handlers) and stops the listener.

## Deployment notes

- The default bind is `127.0.0.1`. `SLASK_MCP_BIND=0.0.0.0` exposes the
  port on the LAN.
- The server itself speaks plain HTTP — put TLS in front (reverse proxy)
  for any network you don't control.
