// Minimal slask-mcp client — connects to one MCP server at a time, over
// streamable HTTP (`connect`) or raw stdio (`connectStdio`), using the
// official @modelcontextprotocol/client SDK.
//
// `url` must be the full endpoint (including `/mcp`). `token`, when
// given, is sent as `Authorization: Bearer <token>` on every request
// (see client/README.md).
//
// This module is the single place that knows how to talk to the MCP
// server, so it also carries the small helpers both cli.js and the
// chat UI (ui.js / agent.js) need: textFrom, mcpResultToText, hintFor,
// printTools.

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

/**
 * Create and connect a stdio client. `params` is the `StdioServerParameters`
 * shape used by the transport:
 *   command       (required) executable to spawn
 *   args          (optional) argument list
 *   env           (optional) env vars, merged over the inherited defaults
 *   cwd           (optional) working directory
 *   stderr        (optional) default "inherit"
 *   maxBufferSize (optional, bytes) default 10 MiB
 * Returns a connected `Client`.
 */
export async function connectStdio({ command, args, env, cwd, stderr, maxBufferSize } = {}) {
  const transport = new StdioClientTransport({
    command,
    args,
    env,
    cwd,
    stderr,
    maxBufferSize,
  });
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

// ---------------------------------------------------------------------------
// Shared helpers: MCP result → display text, and error hints.
// ---------------------------------------------------------------------------

/** Flatten an MCP text `content` block array into a plain string. */
export function textFrom(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Turn an MCP tool result into a single string that is either shown to the
 * user (`cli.js`) or fed back to the model (`agent.js`).
 *
 *  - error        → `Error: <message>`
 *  - structured   (search_tools) → pretty JSON
 *  - text         → the text blocks joined
 *  - empty/absent → `no output`
 */
export function mcpResultToText(result) {
  if (result == null) return "no output";
  if (result.isError) {
    const text = textFrom(result.content);
    return text ? `Error: ${text}` : "Error: (no message)";
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent, null, 2);
  }
  const text = textFrom(result.content);
  return text ? text : "no output";
}

/** One-line hint for the common HTTP failures the server's baseplate emits. */
export function hintFor(message) {
  if (/401|unauthorized/i.test(message))
    return " (The server wants a Bearer token — set SLASK_MCP_TOKEN or --token.)";
  if (/413|payload/i.test(message))
    return " (The server limits request bodies to 1 MiB.)";
  if (/504|timed out/i.test(message))
    return " (The server limits requests to 10 s.)";
  return "";
}

/**
 * Pretty-print a set of MCP tools, grouped by server (used by `list` and the
 * REPL's `/tools`).
 *
 * `views` is an array of server views, each
 *   `{ name, kind, keyedTools: [{ key, tool }] }`
 * where `tool` is a raw tool `{ name, description, inputSchema }` and `key` is the
 * name users use to call it — the raw name when unique across servers, or
 * `<serverName>__<toolName>` when two or more servers share that tool name.
 * With a single view the output matches the original flat format (no group
 * header, 2-space tool indent, 6-space schema indent).
 */
export function printTools(views) {
  const total = views.reduce((n, v) => n + v.keyedTools.length, 0);
  console.log(`${total} tool(s):\n`);
  const grouped = views.length > 1;
  const toolPad = grouped ? "    " : "  ";
  const schemaPad = grouped ? "        " : "      ";
  for (const view of views) {
    if (grouped) console.log(`${toolPad}${view.name} (${view.kind})`);
    for (const { key, tool } of view.keyedTools) {
      console.log(`${toolPad}${key}  —  ${tool.description ?? ""}`);
      if (tool.inputSchema) console.log(`${schemaPad}${JSON.stringify(tool.inputSchema)}`);
    }
  }
}
