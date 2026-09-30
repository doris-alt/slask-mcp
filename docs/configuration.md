# Configuration

Everything is via environment variables. Only the HTTP transport reads
them, and `--http` mode additionally loads a `.env` file (via `dotenvy`)
if one exists in the current directory. `serve_stdio()` has no configuration
env vars and ignores `.env` entirely.

| Variable           | Default              | Applies to  | Description                                                                            |
| ------------------ | -------------------- | ----------- | -------------------------------------------------------------------------------------- |
| `SLASK_MCP_PORT`   | `8000`               | HTTP        | listen port; an unparseable value falls back to 8000                                   |
| `SLASK_MCP_BIND`   | `127.0.0.1`          | HTTP        | bind address; missing or whitespace-only → 127.0.0.1; use `0.0.0.0` for the LAN        |
| `SLASK_MCP_TOKEN`  | unset (no auth)      | HTTP        | HTTP Bearer token, trimmed; empty → no auth — see [authentication](authentication.md)  |
| `RUST_LOG`         | `info` (when unset)  | both        | tracing filter, e.g. `RUST_LOG=debug`                                                  |

## `.env.example`

The template ships in the repo root — copy to `.env` and edit:

```env
# Port for the HTTP (streamable) transport (default 8000)
SLASK_MCP_PORT=8000

# Bind address for HTTP (default 127.0.0.1; use 0.0.0.0 to expose on the LAN)
SLASK_MCP_BIND=127.0.0.1

# (optional) HTTP Bearer token. When set, every request on the HTTP transport
# must send `Authorization: Bearer <token>`, otherwise the server returns
# 401 Unauthorized. Leave blank/unset to leave the HTTP transport open.
# The stdio transport is never affected by this.
SLASK_MCP_TOKEN=
```

Only `--http` mode loads `.env`.

## Startup message

With a token set:

```
serving MCP over streamable HTTP at 127.0.0.1:9000/mcp (Bearer auth enabled)
```

Without:

```
serving MCP over streamable HTTP at 127.0.0.1:9000/mcp (no auth)
```

Both lines go to stderr.
