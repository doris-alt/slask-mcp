#!/usr/bin/env node
// cli.ts — a CLI for MCP servers (streamable HTTP + stdio).
//
//   slask-client                 interactive chat (OpenAI agent + MCP tools)
//   slask-client chat            same
//   slask-client --prompt <text> run one agent turn, print the answer, and exit
//   slask-client list            list all tools (across every connected server)
//   slask-client call <tool> …   call a tool directly and print its result
//   slask-client skill list      list local skills (./skills/)
//   slask-client skill show <n>  show a skill's body and bundled files
//   slask-client skill run <n> <script> [args…]  run a skill's bundled script
//   slask-client schedule               run the scheduler daemon (Ctrl+C to stop)
//   slask-client schedule add <expr> <p>  add a scheduled one-shot job
//   slask-client schedule list           list scheduled jobs
//   slask-client schedule rm <id>        remove a scheduled job
//   slask-client help
//
// The default slask server is configured via --url/--token (or
// SLASK_MCP_URL/SLASK_MCP_TOKEN) and is always included (named "slask") unless
// --no-default. Additional servers — HTTP or stdio, any number — come from a
// JSON config file (default: mcp.json in the current dir; override with --config/-c or
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

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runOneShot, startChat } from "./ui.js";
import {
  addJob,
  listJobs,
  removeJob,
  runScheduler,
} from "./schedule.js";
import { hintFor, printTools, textFrom } from "./client.js";
import { loadEnvFile } from "./env.js";
import {
  buildSpecs,
  callToolBy,
  closeAll,
  connectAllServers,
  loadConfigServers,
} from "./servers.js";
import { DEFAULT_MODEL } from "./agent.js";
import {
  discoverSkills,
  executeScript,
  loadSkill,
  locateScript,
} from "./skills.js";
import type { CallToolResult, HttpSpec, Registry, ServerSpec } from "./types.js";

const DEFAULT_URL = "http://127.0.0.1:8000/mcp";

const HELP = `slask-client — a CLI for MCP servers (streamable HTTP + stdio)

Usage:
  slask-client                 Run the interactive agent chat (default).
  slask-client chat            Same as the default.
  slask-client --prompt <text> Run one agent turn with <text>, print the
                               answer, and exit (no REPL).
  slask-client list
      List all tools (across every connected server) with their input schemas.
  slask-client call <tool> [options]
      Call a tool and print its result.
        --args '<json>'   JSON object of arguments
        --message <text>  echo: the message to echo
        --query <text>    search_tools: the search query
  slask-client skill list
      List local skills from ./skills/ (name + description). No MCP
      connection is made.
  slask-client skill show <name>
      Show a skill's body and its bundled files (paths relative to the
      skill's SKILL.md). No MCP connection is made.
  slask-client skill run <skill> <script> [args…]
      Execute a script from a skill's \`scripts/\` folder and print its output.
      No MCP connection is made.
  slask-client schedule
      Run the scheduler daemon: fires scheduled jobs while this process is
      alive; Ctrl+C to stop. Jobs are stored in .slask-schedule.json in the
      current directory (same convention as .env / mcp.json).
  slask-client schedule add <expr> <prompt>
      Add a job: run <prompt> via a one-shot client run whenever <expr>
      (standard 5-field cron) matches. First fire is the next occurrence
      after scheduling.
  slask-client schedule list
      List scheduled jobs: id, expression, prompt, last run / status.
  slask-client schedule rm <id>
      Remove a scheduled job by full id or unique id prefix.
  slask-client help
      Show this help (also: --help).

Options:
  -u, --url <url>        Default (slask) server endpoint (default: ${DEFAULT_URL})
  -t, --token <token>    Bearer token for the default server
  -c, --config <path>    MCP servers config file (JSON; default: mcp.json in the current dir)
      --no-default       Do not include the default slask server
  -m, --model <model>    OpenAI model (chat mode; default: gpt-4o-mini)
  -p, --prompt <text>    Run one agent turn with this prompt, print the answer,
                         and exit (instead of the interactive REPL).
  -q, --quiet            Omit the startup banner with --prompt (daemon-fired
                         one-shot runs show prompt + answer only)
  -b, --base-url <url>   OpenAI-compatible base URL (chat; overrides API_BASE)
  Env vars (a .env file in the current dir is read on startup; shell values
             win): SLASK_MCP_URL, SLASK_MCP_TOKEN (default server);
             SLASK_MCP_CONFIG (config file); API_BASE (default
             https://api.openai.com), MODEL/OPENAI_MODEL, OPENAI_API_KEY (chat).
             A local OpenAI-compatible server (e.g. Ollama) needs no API key.

Multiple servers:
  The default slask HTTP server is always included (named "slask", from
  --url / SLASK_MCP_URL). To add servers, copy client/mcp.example.json to
  mcp.json in the current directory and list entries — each is a full server
  spec. Any number
  of servers is allowed:
      {"name":"weather","type":"stdio","command":"/path/weather-mcp","args":["--verbose"],"env":{"KEY":""}}
      {"name":"cal","type":"http","url":"http://host:9001/mcp","token":"secret"}
  When two servers expose a tool with the same name it is namespaced as
  <serverName>__<toolName>; names unique across servers are called un-prefixed.

Script execution:
  Each skill may bundle a \`scripts/\` folder. Its .sh/.py/.js files can be run
  by the agent (\`run_skill_script\`) and by \`skill run\` via bash/python3/node,
  only inside that folder, with a 30 s timeout and capped output. The client
  runs whatever scripts its skills contain (an opt-in local feature).

Examples:
  slask-client                                  # interactive agent chat
  SLASK_MCP_URL=http://127.0.0.1:9000/mcp OPENAI_API_KEY=sk-… slask-client
  SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 \\
      MODEL=gemma4:12b-mlx slask-client         # local model, no API key needed
  slask-client --prompt "what time is it now?"
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
  prompt: string | null;
  quiet: boolean;
  help: boolean;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

async function handleSkillCommand(config: CliConfig): Promise<void> {
  const subcmd = config.positional[1];
  const name = config.positional[2];
  const skills = await discoverSkills(process.cwd());
  if (subcmd === undefined) {
    fail(
      "usage: skill list | skill show <name> | skill run <skill> <script> [args…]",
    );
  }
  if (subcmd === "list") {
    const dir = resolve(process.cwd(), "skills");
    console.log(`${skills.length} skill(s) in ${dir}:\n`);
    if (skills.length > 0) {
      for (const s of skills) {
        const scripts = s.scripts.length
          ? ` (scripts: ${s.scripts.join(", ")})`
          : "";
        console.log(`  ${s.name} — ${s.description}${scripts}`);
      }
    } else {
      console.log("  (none found)");
    }
    return;
  }
  if (subcmd === "show") {
    if (name === undefined) fail("usage: skill show <name>");
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      fail(
        `no skill named "${name}" (available: ${
          skills.length ? skills.map((s) => s.name).join(", ") : "none"
        })`
      );
    }
    const { body, files } = await loadSkill(skill);
    console.log(body);
    for (const f of files) {
      console.log("\n--- " + f.rel + " ---\n" + f.content);
    }
    return;
  }
  if (subcmd === "run") {
    const skillName = config.positional[2];
    const scriptName = config.positional[3];
    if (skillName === undefined || scriptName === undefined) {
      fail("usage: skill run <skill> <script> [args…]");
    }
    const found = skills.find((s) => s.name === skillName);
    if (!found) {
      fail(
        `no skill named "${skillName}" (available: ${
          skills.length ? skills.map((s) => s.name).join(", ") : "none"
        })`,
      );
    }
    try {
      const scriptPath = await locateScript(found, scriptName);
      const result = await executeScript(
        scriptPath,
        config.positional.slice(4),
        process.cwd(),
        { ...process.env, SLASK_SKILL_DIR: found.dir },
      );
      process.stdout.write(result.stdout);
      if (result.stderr.trim() !== "") process.stderr.write(result.stderr);
      if (result.timedOut) process.stderr.write("\n(run timed out)\n");
      process.exitCode = result.exitCode;
      return;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }
  fail(
    `unknown skill command: ${subcmd} (try "list", "show <name>", or ` +
      `"run <skill> <script>")`,
  );
}

// No server connection needed — everything works on the jobs file only.
async function handleScheduleCommand(config: CliConfig): Promise<void> {
  const subcmd = config.positional[1];

  if (subcmd === undefined) {
    // Daemon: run the scheduler in this process until SIGINT/SIGTERM. The
    // autoHandlers default installs the shutdown handlers that exit cleanly
    // (exit code 0) on Ctrl+C / SIGTERM.
    await runScheduler();
    return;
  }
  if (subcmd === "add") {
    const expr = config.positional[2];
    const prompt = config.positional[3];
    if (expr === undefined || prompt === undefined) {
      fail("usage: schedule add <expr> <prompt> — <expr> is a 5-field cron");
    }
    try {
      const job = await addJob(expr, prompt);
      console.log(`added job ${job.id.slice(0, 6)} — "${job.expr}" ${job.prompt}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (subcmd === "list") {
    const jobs = await listJobs();
    if (jobs.length === 0) {
      console.log(
        "no scheduled jobs yet — add one with: slask-client schedule add <expr> <prompt>",
      );
      return;
    }
    console.log(`${jobs.length} job(s):\n`);
    for (const j of jobs) {
      console.log(`  ${j.id.slice(0, 6)}  ${j.expr.padEnd(20)}  ${j.prompt}`);
      const last = j.lastRun
        ? `last: ${j.lastRun.slice(0, 16)} (${j.lastStatus})`
        : "last: none yet";
      console.log(`${" ".repeat(32)}${last}`);
    }
    return;
  }
  if (subcmd === "rm") {
    const ref = config.positional[2];
    if (ref === undefined) {
      fail("usage: schedule rm <id> (full id or a unique prefix)");
    }
    const jobs = await listJobs();
    const matches = jobs.filter((j) => j.id === ref || j.id.startsWith(ref));
    if (matches.length === 0) {
      fail(`no such job: ${ref}`);
      return;
    }
    if (matches.length > 1) {
      fail(
        `${matches.length} jobs match prefix "${ref}" (ambiguous) — ` +
          "use a longer prefix or the full id",
      );
      return;
    }
    const job = matches[0];
    await removeJob(job.id);
    console.log(`removed job ${job.id.slice(0, 6)} — "${job.expr}"`);
    return;
  }
  fail(`unknown schedule command: ${subcmd} (try "add", "list", "rm")`);
}

// Hand-rolled flag/positional parsing (no dependencies).
//
// Exported so tests can drive it in-process; the module entrypoint below is
// guarded so *importing* cli.js (tests) does not run the CLI.
export function parse(argv: string[]): CliConfig {
  const config: CliConfig = {
    url: process.env.SLASK_MCP_URL ?? DEFAULT_URL,
    token: process.env.SLASK_MCP_TOKEN ?? null,
    config: null,
    noDefault: false,
    model: null,
    base: null,
    positional: [],
    args: {},
    prompt: null,
    quiet: false,
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
    } else if (f === "--prompt" || f === "-p") {
      if (++i < argv.length) config.prompt = argv[i];
    } else if (f === "--quiet" || f === "-q") {
      config.quiet = true;
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
  // Load .env from the current working directory (if present). Never
  // overwrites values the shell already set.
  loadEnvFile(resolve(process.cwd(), ".env"));

  const config = parse(process.argv.slice(2));
  const sub = config.positional[0];

  // `help` (positional or --help/-h) needs no connection — print and return.
  if (config.help || sub === "help" || sub === "-h" || sub === "--help") {
    console.log(HELP.trimEnd());
    return;
  }

  // `skill` only reads local files — dispatch it before touching any server.
  if (sub === "skill") {
    await handleSkillCommand(config);
    return;
  }

  // `schedule` touches only the jobs file (daemon, add, list, rm) — dispatch
  // it before touching any server, same pattern as `skill`.
  if (sub === "schedule") {
    try {
      await handleScheduleCommand(config);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }

  // Fail fast on an unknown command before touching any server.
  if (
    sub !== undefined &&
    sub !== "" &&
    sub !== "chat" &&
    sub !== "list" &&
    sub !== "call" &&
    sub !== "schedule"
  ) {
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
    if (config.prompt) {
      const code = await runOneShot({
        registry,
        model,
        base: config.base,
        prompt: config.prompt,
        quiet: config.quiet,
      });
      process.exit(code);
    } else {
      await startChat({ registry, model, base: config.base });
    }
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

// cli.js is the entrypoint only when executed directly — i.e. its path matches
// process.argv[1]. Importing cli.js (tests pulling out `parse`) must NOT run
// the CLI, otherwise it would connect to servers and exit the process.
if (
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  void main();
}
