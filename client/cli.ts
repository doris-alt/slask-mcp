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
//   slask-client schedule add <s> <p>   add a job: <s> = 5-field cron (recurring)
//                                       or space-free ISO date/time (one-shot)
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

import { statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runOneShot, startChat } from "./ui.js";
import { handleRalphCli, setRalphForwardArgs } from "./ralph.js";
import {
  addJob,
  classifyScheduleArg,
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
  slask-client schedule add [at] <schedule> <prompt>
      Add a job. <schedule> is either a 5-field cron expression (recurring:
      run <prompt> on every match, first fire is the next occurrence) or a
      space-free ISO date/time (one-shot: run <prompt> exactly once at that
      time). An optional leading literal \`at\` is ignored before a one-shot
      date/time for readability (e.g. add at "2026-10-20T09:30:00Z" p).
  slask-client schedule list
      List scheduled jobs: id, schedule (cron expr or one-shot time), prompt,
      last run / status.
  slask-client schedule rm <id>
      Remove a scheduled job by full id or unique id prefix.
  slask-client ralph init <name> [--mode code|research] [--check <cmd>] [--from prd.json] [--spec <file> [--plan]] [--out <dir>]
      Create a Ralph run in .slask-ralph/<name>/: a task list worked through by
      repeated fresh-context agent iterations until every task passes. --check
      is the code verifier (e.g. "npm run build && npm test"); research runs are
      judged by a checker pass. --from imports a prd.json (tasks or snarktank
      userStories). Research findings/ and report.md go to the visible folder
      --out <dir> (default ralph-<name>/, relative to the workspace); the hidden
      .slask-ralph/<name>/ holds only loop state.
      --spec <file> attaches a project description (markdown, e.g. a PRD) that
      is copied to .slask-ralph/<name>/spec.md for every iteration to read; add
      --plan to have the model draft the task list from it (non-interactive).
  slask-client ralph spec <name> <file>
      Replace a run's project description.
  slask-client ralph add <name> <title> [--criteria "a;b;c"]
      Append a task.
  slask-client ralph run <name> [--max N]
      Run the loop in the foreground (default 10 iterations).
  slask-client ralph start <name> | stop <name> | status [name] | list
      Run in a detached process / stop / inspect. In chat, use /ralph or just
      ask the model to plan one.
  slask-client help
      Show this help (also: --help).

Options:
  -u, --url <url>        Default (slask) server endpoint (default: ${DEFAULT_URL})
  -t, --token <token>    Bearer token for the default server
  -C, --dir <path>       Workspace directory: run as if started there (.env, mcp.json,
                         skills/, file tools, schedule + Ralph state all resolve in it).
                         Relative --config/--from paths are relative to it.
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
  dir: string | null;
  ralph: { mode?: string; check?: string; max?: string; from?: string; criteria?: string; out?: string; spec?: string; plan?: boolean };
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

/**
 * Split the positional args that follow `schedule add` into the job's
 * `scheduleRaw` (a cron expr or one-shot date/time, to be classified) and its
 * `prompt`. An optional leading literal `at` is a readability keyword that is
 * ignored — it just shifts the schedule/prompt one slot right:
 *   add <schedule> <prompt>         -> scheduleRaw=pos[2], prompt=pos[3]
 *   add at <schedule> <prompt>      -> scheduleRaw=pos[3], prompt=pos[4]
 * Either slot is `undefined` when the args are missing; the caller reports the
 * usage error. (`positional[0]` = "schedule", `positional[1]` = "add".)
 */
export function parseScheduleAddArgs(
  positional: string[],
): { scheduleRaw?: string; prompt?: string } {
  const atKeyword = positional[2] === "at";
  return {
    scheduleRaw: atKeyword ? positional[3] : positional[2],
    prompt: atKeyword ? positional[4] : positional[3],
  };
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
    const { scheduleRaw, prompt } = parseScheduleAddArgs(config.positional);
    if (scheduleRaw === undefined || prompt === undefined) {
      fail(
        'usage: schedule add [at] <schedule> <prompt> — <schedule> is a 5-field ' +
          'cron (e.g. "0 9 * * *") or a space-free ISO date/time (one-shot, ' +
          'e.g. "2026-10-20T09:30:00Z"); an optional leading `at` is ignored ' +
          "before a one-shot",
      );
    }
    const cls = classifyScheduleArg(scheduleRaw);
    if ("error" in cls) {
      fail(cls.error);
      return;
    }
    try {
      const job = await addJob({
        prompt,
        expr: cls.kind === "cron" ? cls.expr : undefined,
        at: cls.kind === "once" ? cls.at : undefined,
      });
      const when = job.expr ? `cron "${job.expr}"` : `once @ ${job.at}`;
      console.log(`added job ${job.id.slice(0, 6)} — ${when}: ${job.prompt}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
    return;
  }
  if (subcmd === "list") {
    const jobs = await listJobs();
    if (jobs.length === 0) {
      console.log(
        "no scheduled jobs yet — add one with: slask-client schedule add " +
          "[at] <schedule> <prompt> (recurring cron or one-shot ISO date/time)",
      );
      return;
    }
    console.log(`${jobs.length} job(s):\n`);
    for (const j of jobs) {
      const when =
        j.expr ? j.expr.padEnd(20) : j.at ? j.at.padEnd(20) : "no schedule".padEnd(20);
      console.log(`  ${j.id.slice(0, 6)}  ${when}  ${j.prompt}`);
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
    const when = job.expr ? `cron "${job.expr}"` : `once @ ${job.at}`;
    console.log(`removed job ${job.id.slice(0, 6)} — ${when}`);
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
    dir: null,
    ralph: {},
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
    } else if (f === "--dir" || f === "-C") {
      if (++i < argv.length) config.dir = argv[i];
    } else if (f === "--mode") {
      if (++i < argv.length) config.ralph.mode = argv[i];
    } else if (f === "--check") {
      if (++i < argv.length) config.ralph.check = argv[i];
    } else if (f === "--max") {
      if (++i < argv.length) config.ralph.max = argv[i];
    } else if (f === "--from") {
      if (++i < argv.length) config.ralph.from = argv[i];
    } else if (f === "--out") {
      if (++i < argv.length) config.ralph.out = argv[i];
    } else if (f === "--spec") {
      if (++i < argv.length) config.ralph.spec = argv[i];
    } else if (f === "--plan") {
      config.ralph.plan = true;
    } else if (f === "--criteria") {
      if (++i < argv.length) config.ralph.criteria = argv[i];
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
  // --dir/-C <path> picks the workspace: chdir *first*, so .env, mcp.json,
  // skills, file tools, the schedule file and .slask-ralph/ all resolve there,
  // and every child process inherits it. Pre-scanned because .env must load
  // before the full parse (parse() reads env defaults).
  const dir = parse(process.argv.slice(2)).dir;
  if (dir !== null) {
    const target = resolve(dir);
    try {
      if (!statSync(target).isDirectory()) throw new Error("not a directory");
      process.chdir(target);
    } catch (e) {
      fail(`--dir ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
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

  // Flags that Ralph children (iterations, detached runs) inherit.
  const fwd: string[] = [];
  if (config.model) fwd.push("--model", config.model);
  if (config.base) fwd.push("--base-url", config.base);
  if (config.config) fwd.push("--config", config.config);
  if (config.noDefault) fwd.push("--no-default");
  // url/token already reach children via env when set there; only forward flag
  // overrides (a token on argv is visible in `ps`, so avoid it when env has it).
  if (config.url !== (process.env.SLASK_MCP_URL ?? DEFAULT_URL)) fwd.push("--url", config.url);
  if (config.token && config.token !== process.env.SLASK_MCP_TOKEN) fwd.push("--token", config.token);
  setRalphForwardArgs(fwd);

  // `ralph` manages its own state dir and spawns children for the agent work —
  // dispatch before touching any server, same pattern as `schedule`.
  if (sub === "ralph") {
    try {
      process.exit(await handleRalphCli({ positional: config.positional, ...config.ralph }));
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

  // No reachable MCP server is *not* fatal: the built-in file/schedule tools
  // and local skills stay fully usable, so the client always starts. Per-server
  // warnings are shown here (once) for every command — chat, one-shot, list, call.
  if (registry.views.length === 0 && registry.warnings.length === 0) {
    console.error(
      "⚠ no MCP servers configured — using only built-in tools and local skills."
    );
  }
  for (const w of registry.warnings) {
    console.error(`⚠ could not reach server ${w.name}: ${w.error}${hintFor(w.error)}`);
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
