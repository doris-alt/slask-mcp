// servers.js — multi-server configuration and connection orchestration.
//
// Knows how to (1) load & validate the JSON config file, (2) build the full
// list of server specs (the default slask HTTP server + any servers from the
// config), (3) connect to all of them best-effort, and (4) expose a merged,
// collision-safe view of every tool. Reuses the single-server primitives in
// client.js (connect, connectStdio, listTools, close).
//
// A server *view* is:  { name, kind, client, address, tools, keyedTools }
//   kind        "http" | "stdio"
//   address     the URL (http) or command (stdio), for display
//   tools       raw tools from that server:  { name, description, inputSchema }
//   keyedTools  tools with their user-facing call name (key):
//               [{ key, tool }]  where key = name if unique,
//                               else `<name>__<toolName>` on collision

import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { close, connect, connectStdio, listTools } from "./client.js";

const clientDir = dirname(fileURLToPath(import.meta.url));

/** The default config file, relative to the client (not the cwd). */
export const DEFAULT_CONFIG_PATH = join(clientDir, "mcp.json");

/**
 * Pick the config path from (in order) an explicit flag, an env var, or the
 * default path. `explicit` means the user supplied it (flag/env); the default
 * path is treated as "may be absent".
 */
function resolveConfigPath(flag, envVar, defaultPath) {
  if (flag) return { path: flag, explicit: true };
  if (envVar) return { path: envVar, explicit: true };
  return { path: defaultPath, explicit: false };
}

/**
 * Load and validate the config file's server list. A missing *default* path
 * yields an empty list (no additional servers). A missing *explicitly*-given
 * path is an error.
 */
export async function loadConfigServers({ flag, envVar, defaultPath = DEFAULT_CONFIG_PATH }) {
  const { path, explicit } = resolveConfigPath(flag, envVar, defaultPath);
  let st;
  try {
    st = await fs.stat(path);
  } catch {
    st = null;
  }
  if (!st) {
    if (explicit) throw new Error(`config file not found: ${path}`);
    return [];
  }
  const raw = await fs.readFile(path, "utf8");
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    throw new Error(`config file is not valid JSON: ${e.message}`);
  }
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.servers)) {
    throw new Error("config must be an object with a top-level `servers` array");
  }
  return obj.servers.map((s, i) => validateServer(s, i));
}

/** Turn one raw config entry into a unified server spec. Throws on bad input. */
function validateServer(s, i) {
  if (!s || typeof s !== "object") throw new Error(`servers[${i}] must be an object`);
  const { name, type, url, token, command, args, env, cwd, stderr, maxBufferSize } = s;
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error(`servers[${i}].name must be a non-empty string`);
  }
  if (name.includes("__")) {
    throw new Error(`servers[${i}].name must not contain "__"`);
  }
  if (type === "http") {
    if (!url || typeof url !== "string") {
      throw new Error(`servers[${i}].url is required for type "http"`);
    }
    try {
      new URL(url);
    } catch {
      throw new Error(`servers[${i}].url is not a valid URL: ${url}`);
    }
    return { name, kind: "http", url, token: typeof token === "string" && token !== "" ? token : null };
  } else if (type === "stdio") {
    if (!command || typeof command !== "string" || command.trim() === "") {
      throw new Error(`servers[${i}].command is required for type "stdio"`);
    }
    return {
      name,
      kind: "stdio",
      command,
      args: Array.isArray(args) ? args : undefined,
      env: env && typeof env === "object" ? env : undefined,
      cwd: typeof cwd === "string" ? cwd : undefined,
      stderr: typeof stderr === "string" ? stderr : undefined,
      maxBufferSize: typeof maxBufferSize === "number" && maxBufferSize > 0 ? maxBufferSize : undefined,
    };
  } else {
    throw new Error(`servers[${i}].type must be "http" or "stdio", got ${JSON.stringify(type)}`);
  }
}

/**
 * Assemble the full server list: an optional default slask HTTP server (built
 * from `--url`/`--token` or the env defaults) plus any servers from the config.
 * Rejects duplicate names.
 */
export function buildSpecs({ defaultSpec = null, configServers = [] }) {
  const specs = [];
  if (defaultSpec) specs.push(defaultSpec);
  for (const s of configServers) specs.push(s);
  const seen = new Set();
  for (const spec of specs) {
    if (seen.has(spec.name)) {
      throw new Error(`duplicate server name "${spec.name}"`);
    }
    seen.add(spec.name);
  }
  return specs;
}

async function connectSpec(spec) {
  const client = spec.kind === "http"
    ? await connect({ url: spec.url, token: spec.token })
    : await connectStdio(spec);
  const tools = await listTools(client);
  return { client, tools };
}

/**
 * Connect to all specs, best-effort: a per-server failure is recorded as a
 * warning and the server skipped, so one dead server never sinks the rest.
 * Returns `{ views, warnings, keyedViews, byKey }`.
 */
export async function connectAllServers(specs) {
  const views = [];
  const warnings = [];
  for (const spec of specs) {
    try {
      const { client, tools } = await connectSpec(spec);
      const view = {
        name: spec.name,
        kind: spec.kind,
        client,
        address: spec.kind === "http" ? spec.url : spec.command,
        tools,
        keyedTools: [], // filled after we know which names collide
      };
      views.push(view);
    } catch (e) {
      warnings.push({ name: spec.name, error: e.message ?? String(e) });
    }
  }

  // Which raw tool names appear on more than one connected server?
  const nameCount = {};
  for (const view of views) for (const t of view.tools) {
    nameCount[t.name] = (nameCount[t.name] ?? 0) + 1;
  }
  const keyedViews = views.map((view) => {
    const keyedTools = view.tools.map((tool) => {
      const key = nameCount[tool.name] > 1 ? `${view.name}__${tool.name}` : tool.name;
      return { key, tool };
    });
    return { ...view, keyedTools };
  });

  // The collision-safe lookup used by `call` and the agent loop.
  const byKey = new Map();
  for (const view of keyedViews) {
    for (const { key, tool } of view.keyedTools) {
      if (byKey.has(key)) {
        throw new Error(`internal: two tools resolve to the same call name "${key}"`);
      }
      byKey.set(key, { view, tool });
    }
  }
  return { views, warnings, keyedViews, byKey };
}

/**
 * Resolve a user-supplied tool name to the server/tool it belongs to.
 * Returns `{ view, tool, key }` or `null`.
 */
export function resolveTool(name, registry) {
  return registry.byKey.get(name);
}

/**
 * Call `name` (a user-facing key) with `args`, routed to the right per-server
 * client. The client is called with the tool's *raw* name (each server only
 * knows its own tool names by their raw names).
 */
export async function callToolBy(name, registry, args = {}) {
  const entry = registry.byKey.get(name);
  if (!entry) {
    throw new Error(`tool "${name}" not found (run \`list\` to see available tools)`);
  }
  return entry.view.client.callTool({ name: entry.tool.name, arguments: args });
}

/** Flatten the registry into key-named, OpenAI-function-ready tool descriptors. */
export function openAiTools(registry) {
  return registry.keyedViews.flatMap((view) =>
    view.keyedTools.map(({ key, tool }) => ({
      name: key,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }))
  );
}

async function closeView(view) {
  try {
    await close(view.client);
  } catch {
    // The server may already be unreachable; nothing left to clean up.
  }
}

export async function closeAll(registry) {
  await Promise.all(registry.views.map(closeView));
}
