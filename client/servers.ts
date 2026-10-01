// servers.ts — multi-server configuration and connection orchestration.
//
// Knows how to (1) load & validate the JSON config file, (2) build the full
// list of server specs (the default slask HTTP server + any servers from the
// config), (3) connect to all of them best-effort, and (4) expose a merged,
// collision-safe view of every tool. Reuses the single-server primitives in
// client.ts (connect, connectStdio, listTools, close).
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
import type {
  CallToolResult,
  Client,
  McpToolLike,
  Registry,
  ServerSpec,
  ServerView,
  Tool,
  Warning,
} from "./types.js";

const clientDir = dirname(fileURLToPath(import.meta.url));

/** The default config file, relative to the client (not the cwd). */
export const DEFAULT_CONFIG_PATH = join(clientDir, "mcp.json");

/**
 * Pick the config path from (in order) an explicit flag, an env var, or the
 * default path. `explicit` means the user supplied it (flag/env); the default
 * path is treated as "may be absent".
 */
function resolveConfigPath(
  flag: string | null | undefined,
  envVar: string | null | undefined,
  defaultPath: string,
): { path: string; explicit: boolean } {
  if (flag) return { path: flag, explicit: true };
  if (envVar) return { path: envVar, explicit: true };
  return { path: defaultPath, explicit: false };
}

/**
 * Load and validate the config file's server list. A missing *default* path
 * yields an empty list (no additional servers). A missing *explicitly*-given
 * path is an error.
 */
export async function loadConfigServers({
  flag,
  envVar,
  defaultPath = DEFAULT_CONFIG_PATH,
}: {
  flag?: string | null;
  envVar?: string | null;
  defaultPath?: string;
}): Promise<ServerSpec[]> {
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
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`config file is not valid JSON: ${msg}`);
  }
  if (!obj || typeof obj !== "object") {
    throw new Error("config must be an object with a top-level `servers` array");
  }
  const cfg = obj as { servers?: unknown[] };
  if (!Array.isArray(cfg.servers)) {
    throw new Error("config must be an object with a top-level `servers` array");
  }
  return cfg.servers.map((s, i) => validateServer(s, i));
}

/** Turn one raw config entry into a unified server spec. Throws on bad input. */
function validateServer(s: unknown, i: number): ServerSpec {
  if (!s || typeof s !== "object") {
    throw new Error(`servers[${i}] must be an object`);
  }
  const {
    name,
    type,
    url,
    token,
    command,
    args,
    env,
    cwd,
    stderr,
    maxBufferSize,
  } = s as Record<string, unknown>;
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
    return {
      name,
      kind: "http",
      url,
      token: typeof token === "string" && token !== "" ? token : null,
    };
  } else if (type === "stdio") {
    if (!command || typeof command !== "string" || command.trim() === "") {
      throw new Error(`servers[${i}].command is required for type "stdio"`);
    }
    return {
      name,
      kind: "stdio",
      command,
      args: Array.isArray(args) ? (args as string[]) : undefined,
      env:
        env && typeof env === "object" ? (env as Record<string, string>) : undefined,
      cwd: typeof cwd === "string" ? cwd : undefined,
      stderr:
        stderr === "inherit" ||
        stderr === "pipe" ||
        stderr === "ignore" ||
        stderr === "overlapped"
          ? stderr
          : undefined,
      maxBufferSize:
        typeof maxBufferSize === "number" && maxBufferSize > 0
          ? maxBufferSize
          : undefined,
    };
  } else {
    throw new Error(
      `servers[${i}].type must be "http" or "stdio", got ${JSON.stringify(type)}`
    );
  }
}

/**
 * Assemble the full server list: an optional default slask HTTP server (built
 * from `--url`/`--token` or the env defaults) plus any servers from the config.
 * Rejects duplicate names.
 */
export function buildSpecs({
  defaultSpec = null,
  configServers = [],
}: {
  defaultSpec?: ServerSpec | null;
  configServers?: ServerSpec[];
}): ServerSpec[] {
  const specs: ServerSpec[] = [];
  if (defaultSpec) specs.push(defaultSpec);
  for (const s of configServers) specs.push(s);
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.name)) {
      throw new Error(`duplicate server name "${spec.name}"`);
    }
    seen.add(spec.name);
  }
  return specs;
}

async function connectSpec(spec: ServerSpec): Promise<{ client: Client; tools: Tool[] }> {
  const client =
    spec.kind === "http"
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
export async function connectAllServers(specs: ServerSpec[]): Promise<Registry> {
  const views: ServerView[] = [];
  const warnings: Warning[] = [];
  for (const spec of specs) {
    try {
      const { client, tools } = await connectSpec(spec);
      const view: ServerView = {
        name: spec.name,
        kind: spec.kind,
        client,
        address: spec.kind === "http" ? spec.url : spec.command,
        tools,
        keyedTools: [], // filled after we know which names collide
      };
      views.push(view);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warnings.push({ name: spec.name, error: msg });
    }
  }

  // Which raw tool names appear on more than one connected server?
  const nameCount = new Map<string, number>();
  for (const view of views)
    for (const t of view.tools) {
      nameCount.set(t.name, (nameCount.get(t.name) ?? 0) + 1);
    }
  const keyedViews = views.map((view) => {
    const keyedTools = view.tools.map((tool) => {
      const key = (nameCount.get(tool.name) ?? 0) > 1 ? `${view.name}__${tool.name}` : tool.name;
      return { key, tool };
    });
    return { ...view, keyedTools };
  });

  // The collision-safe lookup used by `call` and the agent loop.
  const byKey = new Map<string, { view: ServerView; tool: Tool }>();
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
 * Returns `{ view, tool }` or `null`.
 */
export function resolveTool(name: string, registry: Registry): { view: ServerView; tool: Tool } | null {
  return registry.byKey.get(name) ?? null;
}

/**
 * Call `name` (a user-facing key) with `args`, routed to the right per-server
 * client. The client is called with the tool's *raw* name (each server only
 * knows its own tool names by their raw names).
 */
export async function callToolBy(
  name: string,
  registry: Registry,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  const entry = registry.byKey.get(name);
  if (!entry) {
    throw new Error(`tool "${name}" not found (run \`list\` to see available tools)`);
  }
  return entry.view.client.callTool({ name: entry.tool.name, arguments: args });
}

/** Flatten the registry into key-named, OpenAI-function-ready tool descriptors. */
export function openAiTools(registry: Registry): McpToolLike[] {
  return registry.keyedViews.flatMap((view) =>
    view.keyedTools.map(({ key, tool }) => ({
      name: key,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema,
    }))
  );
}

async function closeView(view: ServerView): Promise<void> {
  try {
    await close(view.client);
  } catch {
    // The server may already be unreachable; nothing left to clean up.
  }
}

export async function closeAll(registry: Registry): Promise<void> {
  await Promise.all(registry.views.map(closeView));
}
