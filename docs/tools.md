# Tools

The server advertises exactly two tools. Both are generated from the
`#[tool_router]` impl in [`src/lib.rs`](../src/lib.rs), so names,
descriptions, and schemas all come from source — `tools/list` always
matches the implementation.

All tool results use the standard MCP shape: `result.content` is a list of
blocks (text blocks here) and `result.isError` is a boolean.

## `echo`

> Echoes the input string back to the client.

**Input:** `message: string` (required).

Input schema (as returned by `tools/list`):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": { "message": { "type": "string" } },
  "required": [ "message" ]
}
```

Request / response:

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"hello stdio"}}}
```

→

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"hello stdio"}],"isError":false}}
```

## `current_time_utc`

> Current UTC date and time, ISO 8601.

**Input:** none.

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"current_time_utc","arguments":{}}}
```

→

```json
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"2026-09-28T16:16:16.057+00:00"}],"isError":false}}
```

The value is `chrono::Utc::now().to_rfc3339()` — always UTC (`+00:00`),
with sub-second precision when the fractional part is non-zero.

## Server info (`initialize`)

`initialize` returns:

- `serverInfo.name` — `slask-mcp`
- `serverInfo.version` — the crate version (`0.1.0` at this snapshot)
- `instructions` — the `instructions` attribute from `#[tool_handler]`:
  "Demo server. Tools: `echo({\"message\":...})` echoes a string;
  `current_time_utc()` returns the current UTC time in ISO 8601."
- `capabilities.tools` — `{}` (the server supports tool listing)
- `protocolVersion` — the version the client requested

See [stdio](stdio.md) for the full raw `initialize` response.
