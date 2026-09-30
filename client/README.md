# slask-mcp-client

A tiny Node.js CLI for [slask-mcp](../README.md), talking to it over the
[streamable HTTP](../docs/http.md) transport. Built on the official
[`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client)
SDK, plain ESM, no build step.

## Setup

```bash
cd client
npm install
```

## Start the server

```bash
# no auth
SLASK_MCP_PORT=9000 cargo run -- --http

# with Bearer auth
SLASK_MCP_PORT=9000 SLASK_MCP_TOKEN=secret cargo run -- --http
```

## Usage

```bash
node cli.js list                              # tools + input schemas
node cli.js call echo --message "hi"          # echo
node cli.js call current_time_utc             # current UTC time
node cli.js call search_tools --query echo    # search tools by name/description
node cli.js call echo --args '{"message":"hi"}'   # raw JSON arguments
```

Passing the auth token (only needed when the server runs with
`SLASK_MCP_TOKEN` set):

```bash
node cli.js -t secret --url http://127.0.0.1:9000/mcp call current_time_utc
SLASK_MCP_URL=http://127.0.0.1:9000/mcp SLASK_MCP_TOKEN=secret node cli.js list
```

## Options & environment

| Setting | Flag | Env var | Default |
|---|---|---|---|
| Server endpoint (full URL, **incl. `/mcp`**) | `--url`, `-u` | `SLASK_MCP_URL` | `http://127.0.0.1:8000/mcp` |
| Bearer token | `--token`, `-t` | `SLASK_MCP_TOKEN` | unset (no auth header sent) |

A `.env.example` is provided — copy it to `.env` if you like (already
git-ignored by the repo's `.gitignore`).

## Errors

Non-2xx responses and tool-level failures exit with code 1 and a one-line
message, with hints for the baseplate limits (401 Bearer required, 413 body
too large, 504 request timed out) and for unknown tools.
