# slask-mcp

A minimal MCP server in Rust built on the official
[rmcp](https://github.com/modelcontextprotocol/rust-sdk) SDK. Two demo
tools, two transports (stdio and streamable HTTP), optional Bearer auth on
HTTP.

| Tool | Does |
|---|---|
| `echo` | echoes a string: `{"message":"hi"}` → `"hi"` |
| `current_time_utc` | current UTC time, ISO 8601 |

## Quick start

```bash
cargo build --release

# stdio (default mode) — JSON-RPC on stdin/stdout
./target/release/slask-mcp

# streamable HTTP
SLASK_MCP_PORT=9000 ./target/release/slask-mcp --http
```

```bash
# one tool call over HTTP (token unset → no Authorization header needed)
curl -s -X POST http://127.0.0.1:9000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hi"}}}'
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `SLASK_MCP_PORT` | `8000` | HTTP port |
| `SLASK_MCP_BIND` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |
| `SLASK_MCP_TOKEN` | unset | set → Bearer auth required on HTTP only |

Only `--http` reads environment variables / `.env`; stdio ignores `.env`.
See [docs/configuration.md](docs/configuration.md) for the full table
and `.env.example` details.

## Documentation

The essentials are above; the full documentation lives in
[`docs/`](docs/README.md):

| | |
|---|---|
| [Architecture](docs/architecture.md) | crate layout, HTTP pipeline, session model, shutdown |
| [Tools](docs/tools.md) | `echo` and `current_time_utc`: schemas + examples |
| [Stdio](docs/stdio.md) | raw JSON-RPC handshake, wiring up clients |
| [HTTP](docs/http.md) | endpoint, headers, curl examples |
| [Authentication](docs/authentication.md) | optional Bearer auth (HTTP only) |
| [Configuration](docs/configuration.md) | environment variables, `.env` |
| [Testing](docs/testing.md) | the 10-test integration suite |

`cargo test` verifies everything (10 integration tests; no sockets needed).

## Requirements

Rust 2024 edition (rustc ≥ 1.85).
