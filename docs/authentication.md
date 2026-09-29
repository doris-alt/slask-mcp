# Authentication

Optional **Bearer-token** auth guards the **HTTP transport only**. The
stdio transport is never authenticated — `SLASK_MCP_TOKEN` has no effect
there.

## How it works

Auth is **opt-in**, controlled by one environment variable:

- `SLASK_MCP_TOKEN` **unset or empty** → the HTTP transport is open; no
  header needed (the examples in [http](http.md) work as-is).
- `SLASK_MCP_TOKEN` **set and non-empty** (after trimming) → every request
  to `/mcp` — including `initialize` — must carry
  `Authorization: Bearer <token>`, or the server returns 401 (below).

Behaviour details:

- The `Bearer` scheme is matched **case-insensitively** — `bearer <token>`
  and `BEARER <token>` both work.
- The token is compared **in constant time**: length is checked first, then
  a byte loop that never short-circuits (`ok &= x == y`).
- The token is never written to logs.

## The 401 response

Per the MCP spec, the 401 carries `WWW-Authenticate` so a client knows the
endpoint expects a Bearer token:

```text
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer realm="mcp"
content-type: application/json
```

```json
{"error":"Unauthorized","detail":"Missing or invalid Authorization: Bearer header."}
```

## Behaviour matrix

| Scenario | Result |
|---|---|
| Token unset/empty, no header | accepted |
| Token set, no `Authorization` header | 401 |
| Token set, wrong scheme (e.g. `Basic ...`) | 401 |
| Token set, wrong Bearer token | 401 |
| Token set, `Authorization: bearer <token>` (lowercase scheme) | accepted |
| Token set, correct `Bearer <token>` | accepted — normal JSON-RPC reply |
| Any request without an `Accept` header | 406 (independent of auth) |

## Production notes

- The default bind is `127.0.0.1` — the token is a local-secret story unless
  you deliberately expose the port.
- The server speaks plain HTTP; put TLS in front via a reverse proxy.
- This is a static environment-variable token: no rotation, no revocation.
  If you need those, front the server with an auth-aware proxy.
