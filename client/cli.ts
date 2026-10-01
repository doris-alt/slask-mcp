#!/usr/bin/env node
// cli.ts — a CLI for MCP servers (streamable HTTP + stdio).
//
//   slask-client                 interactive chat (OpenAI agent + MCP tools)
//   slask-client chat            same
//   slask-client list            list all tools (across every connected server)
//   slask-client call <tool> …   call a tool directly and print its result
//   slask-client help
//
// The default slask server is configured via --url/--token (or
// SLASK_MCP_URL/SLASK_MCP_TOKEN) and is always included (named "slask") unless
// --no-default. Additional servers — HTTP or stdio, any number — come from a
// JSON config file (default client/mcp.json; override with --config/-c or
// SLASK_MCP_CONFIG).
//
// Chat (OpenAI agent) config — any OpenAI-compatible endpoint:
//   --base-url / -b <url>       base URL (chat); overrides API_BASE
//   API_BASE                    base URL (default: https://api.openai.com)
//   MODEL                       model name (default: gpt-4o-mini); OPENAI_MODEL
//                               and --model/-m also work. Precedence: flag >
//                               MODEL > OPENAI_MODEL.
//   OPENAI_API_KEY              required only when pointing at real OpenAI; a
//                               local server (e.g. Ollama) is used with a
//                               placeholder key

import { startChat } from "./ui.js";
import { hintFor, printTools, textFrom } from "./client.js";
import {
  buildSpecs,
  callToolBy,
  closeAll,
  connectAllServers,
  loadConfigServers,
} from "./servers.js";
import { DEFAULT_MODEL } from "./agent.js";
import type { CallToolResult, HttpSpec, Registry, ServerSpec } from "./types.js";

const DEFAULT_URL = "http://127.0.0.1:8000/mcp";

const HELP = `slask-client — a CLI for MCP servers (streamable HTTP + stdio)

Usage:
  slask-client                 Run the interactive agent chat (default).
  slask-client chat            Same as the default.
  slask-client list
      List all tools (across every connected server) with their input schemas.
  slask-client call <tool> [options]
      Call a tool and print its result.
        --args '<json>'   JSON object of arguments
        --message <text>  echo: the message to echo
        --query <text>    search_tools: the search query
  slask-client help
      Show this help (also: --help).

Options:
  -u, --url <url>        Default (slask) server endpoint (default: ${DEFAULT_URL})
  -t, --token <token>    Bearer token for the default server
  -c, --config <path>    MCP servers config file (JSON; default: mcp.json in the client dir)
      --no-default       Do not include the default slask server
  -m, --model <model>    OpenAI model (chat mode; default: gpt-4o-mini)
  -b, --base-url <url>   OpenAI-compatible base URL (chat; overrides API_BASE)
  Env vars: SLASK_MCP_URL, SLASK_MCP_TOKEN (default server); SLASK_MCP_CONFIG
             (config file); API_BASE (default https://api.openai.com),
             MODEL/OPENAI_MODEL, OPENAI_API_KEY (chat). A local OpenAI-compatible
             server (e.g. Ollama) needs no API key.

Multiple servers:
  The default slask HTTP server is always included (named "slask", from
  --url / SLASK_MCP_URL). To add servers, copy client/mcp.example.json to
  client/mcp.json and list entries — each is a full server spec. Any number
  of servers is allowed:
      {"name":"weather","type":"stdio","command":"/path/weather-mcp","args":["--verbose"],"env":{"KEY":""}}
      {"name":"cal","type":"http","url":"http://host:9001/mcp","token":"secret"}
  When two servers expose a tool with the same name it is namespaced as
  <serverName>__<toolName>; names unique across servers are called un-prefixed.

Examples:
  slask-client                                  # interactive agent chat
  SLASK_MCP_URL=http://127.0.0.1:9000/mcp OPENAI_API_KEY=sk-… slask-client
  SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 \\
      MODEL=gemma4:12b-mlx slask-client         # local model, no API key needed
  slask-client list
  slask-client call echo --message "hi"
  slask-client call current_time_utc
  slask-client call search_tools --query echo
  slask-client call echo --args '{"message":"hi"}'
  SLASK_MCP_TOKEN=secret slask-client call current_time_utc
  --config ./my-servers.json slask-client       # extra servers from a JSON file
  --no-default slask-client                     # only the servers from the config
`;

interface CliConfig {
  url: string;
  token: string | null;
  config: string | null;
  noDefault: boolean;
  model: string | null;
  base: string | null;
  positional: string[];
  args: Record<string, unknown>;
  help: boolean;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

// Hand-rolled flag/positional parsing (no dependencies).
function parse(argv: string[]): CliConfig {
  const config: CliConfig = {
    url: process.env.SLASK_MCP_URL ?? DEFAULT_URL,
    token: process.env.SLASK_MCP_TOKEN ?? null,
    config: null,
    noDefault: false,
    model: null,
    base: null,
    positional: [],
    args: {},
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];

    if (f === "--help" || f === "-h") {
      config.help = true;
    } else if (f === "--url" || f === "-u") {
      if (++i < argv.length) config.url = argv[i];
    } else if (f === "--token" || f === "-t") {
      if (++i < argv.length) config.token = argv[i];
    } else if (f === "--config" || f === "-c") {
      if (++i < argv.length) config.config = argv[i];
    } else if (f === "--no-default") {
      config.noDefault = true;
    } else if (f === "--model" || f === "-m") {
      if (++i < argv.length) config.model = argv[i];
    } else if (f === "--base-url" || f === "-b") {
      if (++i < argv.length) config.base = argv[i];
    } else if (f === "--args") {
      if (++i < argv.length) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(argv[i]);
        } catch {
          fail(`--args must be valid JSON, got: ${argv[i]}`);
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          fail("--args must be a JSON object");
        }
        Object.assign(config.args, parsed);
      }
    } else if (f === "--message") {
      if (++i < argv.length) config.args.message = argv[i];
    } else if (f === "--query") {
      if (++i < argv.length) config.args.query = argv[i];
    } else {
      config.positional.push(f);
    }
  }

  return config;
}

function onMcpError(err: any, action: string, { sub, tool }: { sub?: string; tool?: string | undefined }) {
  const message = err.message ?? err.code ?? String(err);
  let extra = hintFor(message);
  if (sub === "call" && tool && /tool not found|unknown tool/i.test(message)) {
    extra = " (Run 'slask-client list' to see available tools.)";
  }
  console.error(`${action} failed: ${message}${extra}`);
  process.exit(1);
}

function printResult(result: CallToolResult): void {
  if (result.isError) {
    fail(`tool returned an error: ${textFrom(result.content) || String(result)}`);
  }
  if (result.structuredContent !== undefined) {
    // search_tools returns structured content, not text.
    console.log(JSON.stringify(result.structuredContent, null, 2));
  } else {
    const text = textFrom(result.content);
    if (text) console.log(text);
  }
}

async function main(): Promise<void> {
  const config = parse(process.argv.slice(2));
  const sub = config.positional[0];

  // `help` (positional or --help/-h) needs no connection — print and return.
  if (config.help || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(HELP.trimEnd());
    return;
  }

  // Fail fast on an unknown command before touching any server.
  if (sub !== "" && sub !== "chat" && sub !== "list" && sub !== "call") {
    fail(`unknown command: ${sub}\n\n${HELP}`);
    return;
  }

  // Build the full server list (default slask + config servers) and connect
  // best-effort. This happens for chat, list, and call.
  let registry: Registry;
  try {
    const configServers = await loadConfigServers({
      flag: config.config,
      envVar: process.env.SLASK_MCP_CONFIG,
    });
    const defaultSpec: ServerSpec | null = config.noDefault
      ? null
      : ({ name: "slask", kind: "http", url: config.url, token: config.token } as HttpSpec);
    const specs = buildSpecs({ defaultSpec, configServers });
    registry = await connectAllServers(specs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    fail(`config error: ${msg}`);
    return;
  }

  if (registry.views.length === 0) {
    const last = registry.warnings.length
      ? registry.warnings[registry.warnings.length - 1]
      : null;
    fail(`no MCP servers could be reached` + (last ? ` (last error: ${last.error})` : ""));
    return;
  }

  if (!sub || sub === "chat") {
    const model = config.model ?? process.env.MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    await startChat({ registry, model, base: config.base });
    return;
  }

  if (sub !== "list" && sub !== "call") {
    fail(`unknown command: ${sub}\n\n${HELP}`);
    return;
  }

  // Show any servers we could not reach (skipped, not fatal).
  for (const w of registry.warnings) {
    console.error(`⚠ could not reach server ${w.name}: ${w.error}${hintFor(w.error)}`);
  }

  let action = "the request";
  try {
    if (sub === "list") {
      action = "listing tools";
      printTools(registry.keyedViews);
    } else {
      const tool = config.positional[1];
      if (!tool) fail("usage: call <tool> [options]");
      action = `calling ${tool}`;
      printResult(await callToolBy(tool, registry, config.args));
    }
  } catch (err) {
    onMcpError(err, action, {
      sub,
      tool: config.positional.length > 1 ? config.positional[1] : undefined,
    });
    return;
  }
  await closeAll(registry);
}

main();
