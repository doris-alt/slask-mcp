// Minimal slask-mcp client — connects over streamable HTTP using the
// official @modelcontextprotocol/client SDK.
//
// `url` must be the full endpoint (including `/mcp`). `token`, when
// given, is sent as `Authorization: Bearer <token>` on every request
// (see client/README.md).

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const CLIENT_INFO = { name: "slask-mcp-client", version: "0.1.0" };

/**
 * Create and connect a client. slask-mcp is stateless
 * (`legacy_session_mode(false)`), so every request after the handshake
 * is self-contained.
 */
export async function connect({ url, token } = {}) {
  const transportOptions =
    token
      ? {
          requestInit: {
            headers: { Authorization: `Bearer ${token}` },
          },
        }
      : undefined;

  const transport = new StreamableHTTPClientTransport(new URL(url), transportOptions);
  const client = new Client(CLIENT_INFO);
  await client.connect(transport);
  return client;
}

/** Shut the session down. Safe to call once the server is gone. */
export async function close(client) {
  try {
    await client.close();
  } catch {
    // The server may already be unreachable; nothing left to clean up.
  }
}

/** All tools advertised by the server, with their input schemas. */
export async function listTools(client) {
  return (await client.listTools()).tools;
}

/** Call `name` with `args`; returns the MCP tool result object. */
export async function callTool(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}
