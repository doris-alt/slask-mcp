# Documentation index

Guides for building, running, extending, and testing **slask-mcp**.

| Document | Covers |
|---|---|
| [Architecture](architecture.md) | Crate layout, rmcp integration, the HTTP request pipeline, session model, graceful shutdown |
| [Tools](tools.md) | `echo` and `current_time_utc`: schemas, request/response examples |
| [Stdio transport](stdio.md) | stdin/stdout contract, raw JSON-RPC handshake, wiring up real clients |
| [HTTP transport](http.md) | Streamable HTTP endpoint, required headers, curl examples |
| [Authentication](authentication.md) | Optional Bearer-token auth (HTTP only) |
| [Configuration](configuration.md) | Environment variables and the `.env` file |
| [Testing](testing.md) | The integration suite: what it covers, how it works without sockets, gotchas |

The root `README.md` keeps the essentials (tools, quick start, configuration) compact
and links into here.
