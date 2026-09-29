# Stdio transport

The default mode: `./slask-mcp` with **no** flags (anything other than
`--http` runs stdio).

## Contract

- JSON-RPC 2.0 over stdin/stdout, **newline-delimited** — one JSON object
  per line, in both directions.
- Logs go to **stderr**. stdout must be pure JSON-RPC; the client reads
  everything on it as protocol.
- The first message must be `initialize`, and its params must include
  `clientInfo` with `name` and `version` — required by the MCP spec and by
  rmcp's parser. An `initialize` without `clientInfo` is rejected with
  JSON-RPC error code `-32602` (invalid params).
- After `initialize` you may send `tools/list` and `tools/call` in any
  order; each reply is keyed by its `id`. The server exits when stdin hits
  EOF (Ctrl+D).

## Raw handshake

First run `cargo build --release`. Then:

```bash
./target/release/slask-mcp <<'RPC'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"raw-test","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello stdio"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"current_time_utc","arguments":{}}}
RPC
```

Expected stdout (the two `tools/call` replies may arrive in either order;
the timestamp varies):

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"slask-mcp","version":"0.1.0"},"instructions":"Demo server. Tools: `echo({\"message\":...})` echoes a string; `current_time_utc()` returns the current UTC time in ISO 8601."}}
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"echo","description":"Echoes the input string back to the client.","inputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"message":{"type":"string"}},"required":["message"]}},{"name":"current_time_utc","description":"Current UTC date and time, ISO 8601.","inputSchema":{"type":"object","properties":{}}}]}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hello stdio"}],"isError":false}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"2026-09-28T16:16:16.057+00:00"}],"isError":false}}
```

## Connecting a real client

Any MCP client that can launch a subprocess — for example the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector) in Stdio
mode, or Claude Code:

```json
{
  "mcpServers": {
    "slask-mcp": {
      "type": "stdio",
      "path": "/path/to/target/release/slask-mcp",
      "args": []
    }
  }
}
```

Every real client sends the `initialize` handshake (including `clientInfo`)
for you — the raw snippet above is only needed for debugging.

## Using the library directly

```rust
use slask_mcp::serve_stdio;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    serve_stdio().await // blocks until stdin is closed
    Ok(())
}
```
