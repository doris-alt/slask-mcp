# slask-mcp

A minimal demo MCP server written in Rust with the official [`rmcp`](https://github.com/modelcontextprotocol/rust-sdk) SDK (v3.5.0). It exposes two demo tools:

| Tool | Description |
|---|---|
| `echo` | Echoes the input string back: `{"message": "hi"}` -> `"hi"` |
| `current_time_utc` | Current UTC date/time in ISO 8601, e.g. `2026-09-28T16:16:16+00:00` |

## Transports

- **Stdio** (default): `./slask-mcp` — speak JSON-RPC over stdin/stdout. Point any MCP client (e.g. the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) in Stdio mode) at the binary; it performs the handshake for you.
- **Streamable HTTP**: `./slask-mcp --http` — listens at `127.0.0.1:$SLASK_MCP_PORT/mcp`. When `SLASK_MCP_TOKEN` is set, requests must carry `Authorization: Bearer <token>` (see [Authentication](#authentication)).

## Configuration (`.env`)

Copy `.env.example` to `.env` and edit (only affects the HTTP transport):

```env
SLASK_MCP_PORT=8000        # HTTP port (default 8000)
SLASK_MCP_BIND=127.0.0.1   # HTTP bind address (default 127.0.0.1)
SLASK_MCP_TOKEN=            # (optional) HTTP Bearer token — see Authentication
```

## Authentication

The **stdio** transport is never authenticated — `SLASK_MCP_TOKEN` only affects the HTTP transport. Auth is **opt-in**:

- When `SLASK_MCP_TOKEN` is set and non-empty, every request to `/mcp` (including `initialize`) must send `Authorization: Bearer <token>`. Missing or invalid header → HTTP 401:

```text
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="mcp"
content-type: application/json

{"error":"Unauthorized","detail":"Missing or invalid Authorization: Bearer header."}
```

- When `SLASK_MCP_TOKEN` is unset or empty (the default), the HTTP transport is open and the `curl` examples below work without the header.
- The token is compared in constant time and never logged. `WWW-Authenticate` follows the MCP spec so a client knows the endpoint expects a Bearer token.

## Quick tests

### Stdio (JSON-RPC over a pipe)

> `cargo build --release` first.
>
> **The first stdio message must be `initialize` and must include a `clientInfo` field.** It is required by the MCP spec and by rmcp's parser — an `initialize` without `clientInfo` is rejected with code `-32602`. Every real MCP client sends this automatically; the snippet below is a *raw manual* handshake, so it is shown in full.

```bash
./target/release/slask-mcp <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"raw-test","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello stdio"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"current_time_utc","arguments":{}}}
RPC
```

Expected JSON-RPC on stdout (the two `tools/call` responses may arrive in either order; the timestamp varies):

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"slask-mcp","version":"0.1.0"},"instructions":"Demo server. Tools: `echo({\"message\":...})` echoes a string; `current_time_utc()` returns the current UTC time in ISO 8601."}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echoes the input string back to the client.","inputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"message":{"type":"string"}},"required":["message"]}},{"name":"current_time_utc","description":"Current UTC date and time, ISO 8601.","inputSchema":{"type":"object","properties":{}}}]}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hello stdio"}],"isError":false}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"2026-09-28T16:16:16.057+00:00"}],"isError":false}}
```

Logs (if any) go to **stderr**, so stdout stays clean JSON-RPC.

### Streamable HTTP

```bash
# terminal 1 — start the server (reads SLASK_MCP_PORT from .env / env):
SLASK_MCP_PORT=9000 cargo run -- --http
# terminal 2 — the `Accept` header is required (406 without it).
# If the server has SLASK_MCP_TOKEN set, the `Authorization` header is
# required too (see Authentication); omit it when the token is unset.
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SLASK_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# call a tool:
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer $SLASK_MCP_TOKEN" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}'
```

With `with_json_response(true)` the replies are plain JSON (shown above), not server-sent events.

## Build notes

Uses Rust 2024 edition (rustc >= 1.85). First build downloads dependencies from crates.io. If you're in a network-restricted environment, see the project docs for the `cargo vendor` fallback.
