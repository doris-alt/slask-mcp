# slask-mcp — a small, readable MCP server in Rust

A minimal Model Context Protocol server built on the official
[rmcp](https://github.com/modelcontextprotocol/rust-sdk) SDK. Three demo
tools, two transports (raw **stdio** and **streamable HTTP**), and optional
Bearer-token auth on the HTTP side.

It's a compact baseplate: small enough to read in one sitting, structured
enough that the patterns it shows — rmcp's `#[tool_router]` /
`#[tool_handler]` macros, an axum router with layered middlewares, Bearer
auth, graceful shutdown — carry straight into a real server.

## Tools

| Tool | Does | Example call |
|---|---|---|
| `echo` | echoes a string back to the client | `echo({ "message":"hi" })` → `"hi"` |
| `current_time_utc` | current UTC date & time, ISO 8601 | `current_time_utc()` → `"2026-09-29T12:34:56.789+00:00"` |
| `search_tools` | case-insensitive search over tool names & descriptions, each match returned with its input schema | `search_tools({ "query":"echo" })` → `echo` + its schema |

## Quick start

Two commands to get it running — then poke at it.

```bash
cargo build --release

# stdio (default mode) — JSON-RPC on stdin/stdout; Ctrl+D to quit
./target/release/slask-mcp
```

```bash
# streamable HTTP
SLASK_MCP_PORT=9000 ./target/release/slask-mcp --http
```

One tool call over HTTP (no `Authorization` header needed while the token is
unset):

```bash
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}'
```

## Configuration

Everything is an environment variable; only `--http` reads them (and a `.env`
file):

| Variable | Default | Notes |
|---|---|---|
| `SLASK_MCP_PORT` | `8000` | HTTP port |
| `SLASK_MCP_BIND` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |
| `SLASK_MCP_TOKEN` | unset | set → Bearer auth required on HTTP only |

See [docs/configuration.md](docs/configuration.md) for the full table and
`.env.example` details.

## Documentation

The essentials are above; the full documentation lives in
[`docs/`](docs/README.md):

| | |
|---|---|
| [Architecture](docs/architecture.md) | crate layout, the HTTP pipeline (auth → timeout → body limit → rmcp), session model, graceful shutdown |
| [Tools](docs/tools.md) | `echo`, `current_time_utc`, `search_tools`: schemas + request/response examples |
| [Stdio](docs/stdio.md) | raw JSON-RPC handshake, wiring up real clients |
| [HTTP](docs/http.md) | endpoint, required headers, curl examples, request limits (413/504) |
| [Authentication](docs/authentication.md) | optional Bearer-token auth (HTTP only) |
| [Configuration](docs/configuration.md) | environment variables, `.env` |
| [Testing](docs/testing.md) | the 14-test integration suite — drives the real router, no sockets |
| [Client](client/README.md) | small Node.js CLI over streamable HTTP: `list`, `call <tool>` |

`cargo test` verifies everything: 14 integration tests, no sockets needed.

## Requirements

Rust 2024 edition (rustc ≥ 1.85).
