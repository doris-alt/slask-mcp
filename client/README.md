# slask-mcp-client

A tiny Node.js CLI for [slask-mcp](../README.md), talking to it over the
[streamable HTTP](../docs/http.md) transport. It ships in two modes:

1. **Interactive agent chat (default).** A line-based REPL where you type
   natural language, an OpenAI model decides *which* slask-mcp tools to call
   (`echo`, `current_time_utc`, `search_tools`) using the OpenAI **function
   calling** API, the client runs those tools against the MCP server, feeds
   the results back, and prints the model's final answer. No streaming — one
   complete response at a time, with a `thinking…` spinner.
2. **Direct, non-LLM commands.** `list` and `call <tool>` work exactly as before,
   with no model involved.

Built on the official [`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client)
SDK and the [`openai`](https://www.npmjs.com/package/openai) JS SDK (v7,
Chat Completions). Plain ESM, no build step.

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

## Interactive agent chat

Run the REPL with no subcommand:

```bash
node cli.js
```

Or the explicit `chat` subcommand. Point it at your MCP server and model:

```bash
# local OpenAI-compatible model (e.g. Ollama), no API key needed
SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 MODEL=gemma4:12b-mlx node cli.js

# real OpenAI (needs OPENAI_API_KEY; API_BASE defaults to https://api.openai.com)
SLASK_MCP_URL=http://127.0.0.1:9000/mcp OPENAI_API_KEY=sk-… MODEL=gpt-4o-mini node cli.js
```

Example session:

```
slask-mcp agent

  server : http://127.0.0.1:9000/mcp
  model  : gemma4:12b-mlx
  api    : http://192.168.68.73:11434
  tools  : current_time_utc, echo, search_tools

Type a request (e.g. 'what time is it?'), or /help for commands.

slask-agent > what time is it?
  ▸ current_time_utc({})
      2026-09-30T13:36:53+00:00
  The current UTC time is 2026-09-30T13:36:53.787583674+00:00.
slask-agent >
```

### REPL commands

| Command | What it does |
|---|---|
| `/help`, `/h` | show this help |
| `/tools`, `/t` | list the slask-mcp tools (live, from the server) |
| `/reset`, `/clear`, `/c` | clear the conversation history |
| `/quit`, `/exit`, `/q` (or `Ctrl+C`) | leave the REPL |

Any other line is a chat turn. Tool failures are fed back to the model
(instead of crashing), so a bad/unknown tool name just surfaces as an error
the model can recover from.

## Direct, non-LLM commands

```bash
node cli.js list                              # tools + input schemas
node cli.js call echo --message "hi"          # echo
node cli.js call current_time_utc             # current UTC time
node cli.js call search_tools --query echo    # search tools by name/description
node cli.js call echo --args '{"message":"hi"}'   # raw JSON arguments
```

## Options & environment

| Setting                                           | Flag                | Env var                             | Default                                                                        |
| ------------------------------------------------- | ------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| MCP server endpoint (full URL, **incl. `/mcp`**)  | `--url`, `-u`       | `SLASK_MCP_URL`                     | `http://127.0.0.1:8000/mcp`                                                    |
| Bearer token                                      | `--token`, `-t`     | `SLASK_MCP_TOKEN`                   | unset (no auth header sent)                                                    |
| OpenAI base URL (chat)                            | `--base-url`, `-b`  | `API_BASE`                          | `https://api.openai.com`                                                       |
| OpenAI model (chat)                               | `--model`, `-m`     | `MODEL` (or legacy `OPENAI_MODEL`)  | `gpt-4o-mini`                                                                  |
| OpenAI API key (chat)                             | —                   | `OPENAI_API_KEY`                    | required for real OpenAI; **not** needed for a local OpenAI-compatible server  |

Precedence: `--base-url` > `API_BASE` > default. Model: `--model` > `MODEL` >
`OPENAI_MODEL` > `gpt-4o-mini`. The base URL is normalized to end in `/v1`
automatically, so you can pass either `http://host:11434` or
`http://host:11434/v1`.

A `.env.example` is provided — copy it to `.env` if you like (already
git-ignored by the repo's `.gitignore`).

## How the agent loop works

Each chat turn:

1. The model (Chat Completions + `tools`) is asked with the conversation
   history and a system prompt describing the slask-mcp tools.
2. If it requests tool calls, each is executed via `callTool` against the
   MCP server; the text result is appended as a `tool` message and the
   model is asked again. A per-turn cap of 8 tool round-trips bounds runaway
   loops.
3. When the model stops calling tools, its `content` is printed as the answer
   and both the user line and the assistant answer are pushed to the history.

The MCP `inputSchema` `inputSchema` `$schema` key is stripped before being
passed to OpenAI to avoid strict-mode surprises.

## Errors

Non-2xx responses and tool-level failures exit with code 1 and a one-line
message, with hints for the baseplate limits (401 Bearer required, 413 body
too large, 504 request timed out) and for unknown tools. During an agent
turn, an OpenAI or MCP failure prints a red error line but the REPL stays
alive and re-prompts.
