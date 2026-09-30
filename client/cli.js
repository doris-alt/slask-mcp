#!/usr/bin/env node
// slask-client — a tiny CLI for slask-mcp (streamable HTTP transport).
//
//   slask-client list
//   slask-client call <tool> [options]
//   slask-client help
//
// Server config via flags or environment:
//   --url / SLASK_MCP_URL      (default: http://127.0.0.1:8000/mcp)
//   --token / SLASK_MCP_TOKEN  (Bearer, only when the server asks for one)

import { callTool, close, connect, listTools } from "./client.js";

const DEFAULT_URL = "http://127.0.0.1:8000/mcp";

const HELP = `slask-client — a CLI for the slask-mcp server (streamable HTTP)

Usage:
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
  -u, --url <url>       Server endpoint (default: ${DEFAULT_URL})
  -t, --token <token>   Bearer token for the HTTP transport
  Env vars: SLASK_MCP_URL, SLASK_MCP_TOKEN

Examples:
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

function hintFor(message) {
  if (/401|unauthorized/i.test(message))
    return " (The server wants a Bearer token — set SLASK_MCP_TOKEN or --token.)";
  if (/413|payload/i.test(message))
    return " (The server limits request bodies to 1 MiB.)";
  if (/504|timed out/i.test(message))
    return " (The server limits requests to 10 s.)";
  return "";
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

function printTools(tools) {
  console.log(`${tools.length} tool(s):\n`);
  for (const tool of tools) {
    console.log(`  ${tool.name}  —  ${tool.description}`);
    if (tool.inputSchema) console.log(`      ${JSON.stringify(tool.inputSchema)}`);
  }
}

function textFrom(content) {
  return (Array.isArray(content) ? content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .replace(/\n+$/, "");
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

  if (config.help || config.positional.length === 0) {
    console.log(HELP.trimEnd());
    return;
  }

  const [sub, ...rest] = config.positional;
  let client;
  let action = "the request";

  try {
    client = await connect(config);

    if (sub === "list") {
      action = "listing tools";
      printTools(await listTools(client));
    } else if (sub === "call") {
      const tool = rest[0];
      if (!tool) fail("usage: call <tool> [options]");
      action = `calling ${tool}`;
      printResult(await callTool(client, tool, config.args));
    } else {
      console.error(`unknown command: ${sub}\n\n${HELP}`);
      process.exit(1);
    }
  } catch (err) {
    onMcpError(err, action, { sub, tool: config.positional.length > 1 ? config.positional[1] : undefined });
  } finally {
    if (client) await close(client);
  }
}

main();
