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

| Tool                | Does                                                                                               | Example call                                              |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `echo`              | echoes a string back to the client                                                                 | `echo({ "message":"hi" })` → `"hi"`                       |
| `current_time_utc`  | current UTC date & time, ISO 8601                                                                  | `current_time_utc()` → `"2026-09-29T12:34:56.789+00:00"`  |
| `search_tools`      | case-insensitive search over tool names & descriptions, each match returned with its input schema  | `search_tools({ "query":"echo" })` → `echo` + its schema  |

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

## Client

`slask-client` is a **TypeScript** Node.js CLI that lets a language model use this server (and any other MCP server). It reads `.env` and `mcp.json` from the directory it is launched in (`--config` overrides the path).

What it supports:
- **Multiple MCP servers** — the default slask server plus any number of additional stdio or HTTP servers listed in the config file.
- **Agent chat** — a line-based REPL where an OpenAI-compatible model (real or local, e.g. Ollama) picks tools via function-calling and answers; `--prompt "<text>"` runs a single turn and exits, without the REPL.
- **Local skills** — discovered from `./skills/`: advisory prompt material in `SKILL.md`, plus an optional executable `scripts/` folder (`.sh`/`.py`/`.js`).
- **File tools** — built-in `read_file` / `grep_file` / `edit_file` / `write_file` / `list_files`, hard-sandboxed by the client to the launch directory and its subdirectories (parent, upstream, and neighbouring paths are never reachable; symlinks that resolve outside are rejected in code, not by the model). `list_files` lists directory entries (files and directories, dotfiles included) with optional glob patterns (`*` never crosses `/`, `**` does), optional recursive walk, and a `max_count` bound (default 100, cap 1000) with the total found always reported.
- **Direct commands** — `list` (every tool with its input schema), `call <tool>`, and `skill run <skill> <script>`, all without a model.
- **Name collision** — a tool shared by two servers is namespaced as `<serverName>__<toolName>`.

To build and use it: `npm install && npm run build` in `client/`, then `npx slask-client` (or `node dist/cli.js`). See [`client/README.md`](client/README.md) for the full setup and reference, including the script-execution security model.

## Configuration

Everything is an environment variable; only `--http` reads them (and a `.env`
file):

| Variable           | Default      | Notes                                    |
| ------------------ | ------------ | ---------------------------------------- |
| `SLASK_MCP_PORT`   | `8000`       | HTTP port                                |
| `SLASK_MCP_BIND`   | `127.0.0.1`  | `0.0.0.0` to expose on the LAN           |
| `SLASK_MCP_TOKEN`  | unset        | set → Bearer auth required on HTTP only  |

See [docs/configuration.md](docs/configuration.md) for the full table and
`.env.example` details.

## Documentation

The essentials are above; the full documentation lives in
[`docs/`](docs/README.md):

|                                           |                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| [Architecture](docs/architecture.md)      | crate layout, the HTTP pipeline (auth → timeout → body limit → rmcp), session model, graceful shutdown          |
| [Tools](docs/tools.md)                    | `echo`, `current_time_utc`, `search_tools`: schemas + request/response examples                                 |
| [Stdio](docs/stdio.md)                    | raw JSON-RPC handshake, wiring up real clients                                                                  |
| [HTTP](docs/http.md)                      | endpoint, required headers, curl examples, request limits (413/504)                                             |
| [Authentication](docs/authentication.md)  | optional Bearer-token auth (HTTP only)                                                                          |
| [Configuration](docs/configuration.md)    | environment variables, `.env`                                                                                   |
| [Testing](docs/testing.md)                | the 14-test integration suite — drives the real router, no sockets                                              |
| [Client](client/README.md)                | Node.js CLI over streamable HTTP: interactive OpenAI agent chat (function calling) plus `list` / `call <tool>`  |

`cargo test` verifies everything: 14 integration tests, no sockets needed.

## Requirements

Rust 2024 edition (rustc ≥ 1.85).
