#!/usr/bin/env node
// slask-client — CLI for slask-mcp (streamable HTTP transport).
//
//   slask-client                 interactive chat (OpenAI agent + MCP tools)
//   slask-client chat            same
//   slask-client list            list the server's tools
//   slask-client call <tool> …   call a tool directly and print its result
//   slask-client help
//
// Server config via flags or environment:
//   --url / SLASK_MCP_URL        (default: http://127.0.0.1:8000/mcp)
//   --token / SLASK_MCP_TOKEN    (Bearer, only when the server asks for one)
//
// Chat (OpenAI agent) config — any OpenAI-compatible endpoint:
//   --base-url / -b <url>       base URL (chat); overrides API_BASE
//   API_BASE                    base URL (default: https://api.openai.com)
//   MODEL                       model name (default: gpt-4o-mini); OPENAI_MODEL and
//                               --model/-m also work. Precedence: flag > MODEL > OPENAI_MODEL.
//   OPENAI_API_KEY              required only when pointing at real OpenAI; a local
//                               server (e.g. Ollama) is used with a placeholder key

import { startChat } from "./ui.js";
import {
  callTool,
  close,
  connect,
  hintFor,
  listTools,
  printTools,
  textFrom,
} from "./client.js";
import { DEFAULT_MODEL } from "./agent.js";

const DEFAULT_URL = "http://127.0.0.1:8000/mcp";

const HELP = `slask-client — a CLI for the slask-mcp server (streamable HTTP)

Usage:
  slask-client                 Run the interactive agent chat (default).
  slask-client chat            Same as the default.
  slask-client list
      List the server's tools with their input schemas.
  slask-client call <tool> [options]
      Call a tool and print its result.
        --args '<json>'   JSON object of arguments
        --message <text>  echo: the message to echo
        --query <text>    search_tools: the search query
  slask-client help
      Show this help (also: --help).

Options:
  -u, --url <url>        Server endpoint (default: ${DEFAULT_URL})
  -t, --token <token>    Bearer token for the HTTP transport
  -m, --model <model>    OpenAI model (chat mode; default: gpt-4o-mini)
  -b, --base-url <url>   OpenAI-compatible base URL (chat; overrides API_BASE)
  Env vars: SLASK_MCP_URL, SLASK_MCP_TOKEN (server); API_BASE (default
               https://api.openai.com), MODEL/OPENAI_MODEL, OPENAI_API_KEY (chat).
               A local OpenAI-compatible server (e.g. Ollama) needs no API key.

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
`;

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Hand-rolled flag/positional parsing (no dependencies).
function parse(argv) {
  const config = {
    url: process.env.SLASK_MCP_URL ?? DEFAULT_URL,
    token: process.env.SLASK_MCP_TOKEN ?? null,
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
    } else if (f === "--model" || f === "-m") {
      if (++i < argv.length) config.model = argv[i];
    } else if (f === "--base-url" || f === "-b") {
      if (++i < argv.length) config.base = argv[i];
    } else if (f === "--args") {
      if (++i < argv.length) {
        let parsed;
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

function onMcpError(err, action, { sub, tool } = {}) {
  const message = err.message ?? err.code ?? String(err);
  let extra = hintFor(message);
  if (sub === "call" && tool && /tool not found|unknown tool/i.test(message)) {
    extra = " (Run 'slask-client list' to see available tools.)";
  }
  console.error(`${action} failed: ${message}${extra}`);
  process.exit(1);
}

function printResult(result) {
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

async function main() {
  const config = parse(process.argv.slice(2));
  const sub = config.positional[0];

  // `help` (positional or --help/-h) needs no connection — print and return.
  if (config.help || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(HELP.trimEnd());
    return;
  }

  // No subcommand (or an explicit `chat`) → the interactive agent REPL.
  if (!sub || sub === "chat") {
    // Precedence: --model flag > MODEL > OPENAI_MODEL > default.
    const model =
      config.model ?? process.env.MODEL ?? process.env.OPENAI_MODEL ?? DEFAULT_MODEL;
    // Pass only the flag value; agent.js applies API_BASE, then the default.
    const base = config.base;
    // startChat owns its lifecycle (reads the key, connects, runs the REPL)
    // and exits the process on quit / startup failure.
    await startChat({ url: config.url, token: config.token, model, base });
    return;
  }

  if (sub !== "list" && sub !== "call") {
    fail(`unknown command: ${sub}\n\n${HELP}`);
    return;
  }

  let client;
  let action = "the request";
  try {
    client = await connect(config);

    if (sub === "list") {
      action = "listing tools";
      printTools(await listTools(client));
    } else {
      const tool = config.positional[1];
      if (!tool) fail("usage: call <tool> [options]");
      action = `calling ${tool}`;
      printResult(await callTool(client, tool, config.args));
    }
  } catch (err) {
    onMcpError(err, action, {
      sub,
      tool: config.positional.length > 1 ? config.positional[1] : undefined,
    });
  } finally {
    if (client) await close(client);
  }
}

main();
