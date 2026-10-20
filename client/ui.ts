// ui.ts — the line-based chat REPL for slask-mcp.
//
// Wraps one or more MCP servers (already connected by cli.ts via servers.ts)
// with the OpenAI agent loop (agent.ts): the user types natural language, the
// model decides which MCP tools to call, the client executes them, results feed
// back, and a final answer is printed. Non-streaming, with a small `thinking…`
// spinner and a dependency-free color/ANSI helper. Built on node:readline only
// (no TUI lib). `runOneShot` runs a single agent turn for a prompt and exits,
// used by the `--prompt` flag.
//
// REPL commands: /help /h  /tools /t  /skills /s  /reset /clear /c  /compact /summarize  /schedule add|list|rm  /ralph  /quit /exit /q

import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { OpenAI } from "openai";
import { printTools } from "./client.js";
import { closeAll, callToolBy, openAiTools } from "./servers.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  createOpenAiClient,
  mcpToolsToOpenai,
  runAgentTurn,
} from "./agent.js";
import type {
  CallToolResult,
  ConversationMessage,
  OpenAiFunctionTool,
  Registry,
  ToolCallRecord,
} from "./types.js";
import {
  discoverSkills,
  invokeSkill,
  runSkillScript,
  runScriptTool,
  skillSystemBlock,
  skillTool,
} from "./skills.js";
import type { Skill } from "./skills.js";
import {
  FILE_TOOL_NAMES,
  callFileTool,
  fileSystemBlock,
  fileTools,
} from "./files.js";
import {
  addJob,
  classifyScheduleArg,
  listJobs,
  removeJob,
  SCHEDULE_TOOL_NAMES,
  callScheduleTool,
  scheduleSystemBlock,
  scheduleTools,
} from "./schedule.js";
import {
  RALPH_TOOL_NAMES,
  callRalphTool,
  parseRalphCmd,
  ralphSystemBlock,
  ralphTools,
  runRalphRepl,
} from "./ralph.js";

// ---------------------------------------------------------------------------
// colors (tiny dependency-free ANSI helper)
// ---------------------------------------------------------------------------
const PALETTE = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
} as const satisfies Record<string, string>;

const COLOR_ENABLED = process.stdout.isTTY && !("NO_COLOR" in process.env);
const color = (name: keyof typeof PALETTE, s: string) =>
  COLOR_ENABLED ? `${PALETTE[name]}${s}${PALETTE.reset}` : s;
const PROMPT = color("cyan", "slask-agent > ");

// ---------------------------------------------------------------------------
// spinner (exported so tests can drive `runTurn` against a captured stream)
// ---------------------------------------------------------------------------
const FRAMES = [
  "▋",
  "▙",
  "▹",
  "▸",
  "▼",
  "▴",
  "◦",
  "◧",
  "◇",
  "●",
] as const;

export class Spinner {
  out: Writable;
  timer: ReturnType<typeof setInterval> | null;
  label: string;
  i: number;

  constructor(out: Writable = process.stdout) {
    this.out = out;
    this.timer = null;
    this.label = "";
    this.i = 0;
  }

  start(label: string = "thinking…") {
    // No animation when output is not a terminal (logs, pipes, scheduler and
    // Ralph children): the repainted frames would bloat and garble the log.
    if (!(this.out as { isTTY?: boolean }).isTTY) return;
    if (this.timer) return;
    this.label = label;
    this.i = 0;
    this.out.write(`\r${FRAMES[0]} ${label}`);
    this.timer = setInterval(() => {
      this.i = (this.i + 1) % FRAMES.length;
      this.out.write(`\r${FRAMES[this.i]} ${label}`);
    }, 80);
  }

  // clear the spinner line and leave the cursor at its start
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    } else if (!(this.out as { isTTY?: boolean }).isTTY) {
      return;
    }
    this.out.write(`\r${" ".repeat(this.padWidth() + 4)}\r`);
  }

  // clear the spinner line and move to a fresh line below it
  stopDown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    } else if (!(this.out as { isTTY?: boolean }).isTTY) {
      return;
    }
    this.out.write(`\r${" ".repeat(this.padWidth() + 4)}\r\n`);
  }

  padWidth(): number {
    return this.label ? this.label.length : 0;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function die(msg: string): never {
  console.error(color("red", `\n✖ ${msg}`));
  process.exit(1);
}

const REPLY_HELP = [
  "REPL commands:",
  "  /help     show this help",
  "  /tools    list all tools (across every connected server)",
  "  /skills   list local skills (./skills/)",
  "  /reset    clear the conversation history",
  "  /compact  summarize the conversation so far, reclaiming context",
  "  /schedule manage scheduled jobs (add/list/rm)",
  "  /ralph    plan/run autonomous Ralph loops (coding or research); /ralph alone for help",
  "  /quit     (or /exit, /q, or Ctrl+C) leave the REPL",
  "",
  "Tip: while typing a slash command, press Tab to auto-complete;",
  "press Tab again for the full list of available commands.",
  "",
  "Otherwise, just type a request. Examples:",
  "  what time is it?",
  "  echo the word hello",
  "  which tools can I use?",
].join("\n");

// ---------------------------------------------------------------------------
// /schedule — manage the scheduled-job file (add/list/rm) from the REPL.
// ---------------------------------------------------------------------------
const SCHEDULE_HELP = [
  "  /schedule add [at] <min hour dom month dow> <prompt...>   add a recurring job (5-field cron)",
  "  /schedule add [at] <ISO-date/time> <prompt...>            add a one-shot job " +
  "  (space-free ISO, e.g. 2026-10-20T09:30:00Z; optional leading `at` ignored)",
  "  /schedule list                                       list jobs (id, schedule, prompt, last run/status)",
  "  /schedule rm <id>                                    remove a job by id or unique prefix",
].join("\n");

type ScheduleParse =
  | { kind: "help" }
  | { kind: "add"; expr?: string; at?: string; prompt: string }
  | { kind: "list" }
  | { kind: "rm"; ref: string }
  | { kind: "error"; message: string };

// Parse a "/schedule" REPL line into a structured command, or null if the first
// (lower-cased) token is not exactly "/schedule". For a recurring job the cron
// expression is the first 5 whitespace-separated fields (matching the CLI's 5-field
// convention); everything after field 5 is the prompt (case preserved). For a
// one-shot job the first field after "add" must be a space-free ISO date/time
// (parsed via classifyScheduleArg); everything after it is the prompt. The REPL
// has no shell tokenization, so the line is parsed here.
export function parseScheduleCmd(line: string): ScheduleParse | null {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0].toLowerCase() !== "/schedule") return null;
  if (parts.length === 1) return { kind: "help" };
  const sub = parts[1].toLowerCase();
  if (sub === "add") {
    const rest = parts.slice(2);
    const usage =
      "usage: /schedule add [at] <min hour dom month dow> <prompt...> (5 cron " +
      "fields, then the prompt) — or add [at] <ISO-date/time> <prompt...> for a " +
      "one-shot job (space-free, e.g. 2026-10-20T09:30:00Z; optional leading " +
      "`at` is ignored)";
    if (rest.length === 0) {
      return { kind: "error", message: usage };
    }
    // An optional literal `at` is a readability keyword before a one-shot:
    // it is ignored and just shifts the schedule/prompt one slot right.
    const atKeyword = rest[0].toLowerCase() === "at";
    const scheduleIdx = atKeyword ? 1 : 0;
    const promptIdx = atKeyword ? 2 : 1;
    // One-shot: the schedule token is a single space-free ISO date/time —
    // classifyScheduleArg returns kind:"once" only for genuine hyphenated
    // ISO dates. Everything after it is the prompt (case preserved).
    if (rest[scheduleIdx] !== undefined) {
      const first = classifyScheduleArg(rest[scheduleIdx]);
      if (first.kind === "once" && rest.length >= promptIdx + 1) {
        return {
          kind: "add",
          at: first.at,
          prompt: rest.slice(promptIdx).join(" "),
        };
      }
    }
    // Recurring: the first 5 tokens must be a 5-field cron; the rest is the prompt.
    if (rest.length < 6) {
      return { kind: "error", message: usage };
    }
    const exprCls = classifyScheduleArg(rest.slice(0, 5).join(" "));
    if (exprCls.kind !== "cron") {
      return {
        kind: "error",
        message:
          `${exprCls.kind === "error" ? exprCls.error : "unrecognized schedule"} ` +
          "— use a 5-field cron expression (e.g. 0 9 * * *) or a space-free ISO " +
          "date/time for a one-shot job",
      };
    }
    return { kind: "add", expr: exprCls.expr, prompt: rest.slice(5).join(" ") };
  }
  if (sub === "list") return { kind: "list" };
  if (sub === "rm") {
    if (parts.length < 3) {
      return { kind: "error", message: "usage: /schedule rm <id> (full id or unique prefix)" };
    }
    return { kind: "rm", ref: parts[2] };
  }
  return { kind: "help" }; // unknown subcommand -> help
}

// ---------------------------------------------------------------------------
// slash-command hints — readline's `completer` option (Tab-driven).
//
// node:readline has no live on-keystroke hint display; its completer is the
// only supported mechanism (and the only one without a TUI dependency). It
// runs on each Tab: if all candidates share a prefix that extends the typed
// word, the rest is inserted; otherwise a second Tab prints the full list.
// The completer must always return a 2-element array.
// ---------------------------------------------------------------------------
const SLASH_COMMANDS = [
  "help", "tools", "skills", "reset", "clear",
  "compact", "summarize", "schedule", "ralph",
  "quit", "exit",
];
// Kept in sync with parseScheduleCmd (below) and the /schedule help text.
const SCHEDULE_SUBCOMMANDS = ["add", "list", "rm"];
// Kept in sync with parseRalphCmd in ralph.ts.
const RALPH_SUBCOMMANDS = [
  "add", "check", "init", "list", "plan", "spec", "start", "status", "stop",
];

export function slashCompletions(line: string): [string[], string] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return [[], ""];
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = parts[0];
  const last = parts[parts.length - 1];

  let candidates: string[];
  let completeOn: string;
  if (parts.length === 1) {
    candidates = SLASH_COMMANDS;
    // Strip the slash from completeOn so readline's replace branch never
    // rewrites the leading `/` of the line.
    completeOn = first.replace(/^\//, "");
  } else if (first.toLowerCase() === "/schedule") {
    candidates = SCHEDULE_SUBCOMMANDS;
    completeOn = last;
  } else if (first.toLowerCase() === "/ralph") {
    candidates = RALPH_SUBCOMMANDS;
    completeOn = last;
  } else {
    return [[], ""];
  }

  const q = completeOn.toLowerCase();
  const hits = candidates.filter((c) => c.startsWith(q));
  // No hit → fall back to the full set so a second Tab still shows a hint.
  return [hits.length ? hits : candidates, completeOn];
}

// ---------------------------------------------------------------------------
// shared chat setup (used by the REPL and by one-shot runs)
// ---------------------------------------------------------------------------
export interface ChatState {
  openai: InstanceType<typeof OpenAI>;
  openaiTools: OpenAiFunctionTool[];
  skills: Skill[];
  registry: Registry;
  model: string;
  base: string | null;
  baseDir: string;
}

// Open the OpenAI client, build the MCP tool list, and discover local skills
// (best-effort, like the mcp.json servers). Per-server connection warnings are
// printed once by the caller (cli.ts) before dispatch, so this layer does not
// re-emit them. An `openai` client can be injected (optional seam) so callers
// that don't need a real model (tests) can skip the real `OpenAI` constructor.
async function buildChatState(options: {
  registry: Registry;
  model: string;
  base?: string | null;
  openai?: InstanceType<typeof OpenAI>;
}): Promise<ChatState> {
  const { registry, model } = options;
  const base = options.base ?? null;

  let openai: InstanceType<typeof OpenAI>;
  if (options.openai !== undefined) {
    openai = options.openai;
  } else {
    try {
      openai = createOpenAiClient({ base });
    } catch (e) {
      die(e instanceof Error ? e.message : String(e));
    }
  }

  const openaiTools = mcpToolsToOpenai(openAiTools(registry));

  let skills: Skill[] = [];
  try {
    skills = await discoverSkills(process.cwd());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(color("red", `  ⚠ could not discover local skills: ${msg}`));
  }

  return {
    openai,
    openaiTools,
    skills,
    registry,
    model,
    base,
    baseDir: process.cwd(),
  };
}

// Print the startup banner. `interactive` controls the trailing "type a
// request" hint (shown only in the REPL).
export function printBanner(state: ChatState, interactive: boolean): void {
  const effectiveBase = state.base ?? process.env.API_BASE ?? DEFAULT_API_BASE;
  console.log(color("bold", "\nslask-mcp agent\n"));
  for (const v of state.registry.keyedViews) {
    console.log(`  server : ${color("cyan", v.name)} (${v.kind}) ${v.address}`);
  }
  if (state.registry.keyedViews.length === 0) {
    console.log(`  server : ${color("dim", "(none reached)")}`);
  }
  console.log(`  model  : ${color("cyan", state.model)}`);
  console.log(`  api    : ${color("cyan", effectiveBase)}`);
  // MCP tools (namespaced per server), the built-in file tools, and local-skill
  // tools all show here so the user sees every callable name up front.
  const allToolNames = [
    ...state.openaiTools.map((t) => t.function.name),
    ...FILE_TOOL_NAMES,
    ...SCHEDULE_TOOL_NAMES,
    ...ralphTools().map((t) => t.function.name),
    ...state.skills.map((s) => s.name),
  ];
  console.log(
    `  tools  : ${color(
      "cyan",
      allToolNames.length ? allToolNames.join(", ") : "(none)"
    )}`
  );
  if (state.skills.length > 0) {
    console.log(
      `  skills : ${color(
        "cyan",
        state.skills
          .map((s) =>
            s.scripts.length
              ? `${s.name} [${s.scripts.join(", ")}]`
              : s.name
          )
          .join(", ")
      )}`
    );
  }
  if (interactive) {
    console.log(
      color(
        "dim",
        "\nType a request (e.g. 'what time is it?') or /help for commands. " +
        "Press Tab while typing a slash command for hints.\n"
      )
    );
  }
}

// Run a single user turn: push the prompt, drive the agent loop (with tool
// trace), and return the final answer. Returns null on failure (the error is
// already printed) so the caller can re-prompt or exit.
export async function runTurn(
  state: ChatState,
  prompt: string,
  history: ConversationMessage[],
  spinner: Spinner,
): Promise<string | null> {
  const { openai, openaiTools, skills, model, baseDir } = state;
  const systemPrompt =
    SYSTEM_PROMPT +
    skillSystemBlock(skills) +
    fileSystemBlock() +
    scheduleSystemBlock() +
    ralphSystemBlock();
  const tools = [
    ...openaiTools,
    ...fileTools(),
    ...scheduleTools(),
    ...ralphTools(),
    ...(skills.length > 0 ? [skillTool(skills), runScriptTool(skills)] : []),
  ];
  const callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> =
    (name, args) => {
    // Synthetic local tools (file, schedule, skill); every other name routes to
    // the originating MCP server.
    if (FILE_TOOL_NAMES.includes(name)) {
      return callFileTool(baseDir, name, args);
    }
    if (SCHEDULE_TOOL_NAMES.includes(name)) {
      return callScheduleTool(name, args);
    }
    if (RALPH_TOOL_NAMES.includes(name)) {
      return callRalphTool(baseDir, name, args);
    }
    if (name === "invoke_skill") {
      return invokeSkill(skills, String(args.name), args.file).then(
        (text) => ({ isError: false, content: [{ type: "text", text }] }),
      );
    }
    if (name === "run_skill_script") {
      return runSkillScript(skills, args);
    }
    return callToolBy(name, state.registry, args);
  };

  const onToolCall = (rec: ToolCallRecord) => {
    spinner.stopDown();
    console.log(color("yellow", `  ▸ ${rec.name}(${JSON.stringify(rec.args)})`));
    console.log(color("dim", `      ${rec.resultText.replace(/\n/g, "\n      ")}`));
    spinner.start("thinking…");
  };

  const userMsg: ConversationMessage = { role: "user", content: prompt };
  spinner.start("thinking…");
  history.push(userMsg);
  try {
    const answer = await runAgentTurn(
      { openai, model, systemPrompt, tools, callTool },
      history,
      onToolCall
    );
    spinner.stopDown();
    history.push({ role: "assistant", content: answer });
    return answer;
  } catch (err) {
    spinner.stop();
    // Drop the unprocessed request so a failed turn doesn't pollute history.
    if (history[history.length - 1] === userMsg) history.pop();
    console.log(
      color("red", `${err instanceof Error ? err.message : String(err)}\n`)
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// /compact — roll the conversation up into a short summary that replaces the
// history, reclaiming context. `summarizeHistory` is pure (returns the summary
// or null); `replaceHistoryWithSummary` does the in-place swap the REPL applies.
// Failure-safe: empty history, an empty model answer, or a model error all yield
// null, and the caller leaves `history` untouched in that case.
// ---------------------------------------------------------------------------
const SUMMARY_SYSTEM = [
  "You are turning a past user–agent conversation into a concise summary that",
  "will be re-injected as the new conversation context. Be factual and brief.",
  "Cover, in this order, only the parts that are non-empty:",
  "  1. Goals — what the user is trying to accomplish.",
  "  2. Decisions & actions — tools called, results, things set up/changed.",
  "  3. Open items — unresolved questions or work still pending.",
  "  4. Key context — facts, values, file paths, or constraints the agent must",
  "     remember to continue coherently.",
  "Return ONLY the summary text (no preamble; keep any section heading only if",
  "that section is non-empty). If the conversation is trivial, say so in one line.",
].join("\n");

export async function summarizeHistory(
  state: ChatState,
  history: ConversationMessage[],
): Promise<string | null> {
  // Nothing meaningful to compact: a summary needs at least an exchange
  // (a user message and its answer).
  if (history.length < 2) {
    return null;
  }

  // A plain transcript: "user: …" / "assistant: …" lines. In REPL history each
  // message carries a non-null string content; null content is skipped
  // defensively.
  const transcript = history
    .flatMap((m) => (m.content == null ? [] : [`${m.role}: ${m.content}`]))
    .join("\n");
  if (transcript.trim() === "") {
    return null;
  }

  try {
    const res = await state.openai.chat.completions.create({
      model: state.model,
      temperature: 0.5,
      max_tokens: 1024,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        {
          role: "user",
          content:
            "Summarize the conversation below into concise plain text that can " +
            "replace it as prior context. Keep only goals, decisions/actions, " +
            "open items, and key facts.\n\n" +
            transcript,
        },
      ],
    });
    const content = res?.choices?.[0]?.message?.content;
    return content ? content.trim() : null;
  } catch {
    // Network / auth / token-limit / malformed response: never mutate the
    // caller's history on failure.
    return null;
  }
}

// In-place /compact swap: drop the old history and seed a single user-role
// message holding the summary. Returns how many messages were replaced, so the
// REPL can print a "compacted N messages" confirmation.
export function replaceHistoryWithSummary(
  history: ConversationMessage[],
  summary: string,
): number {
  const removed = history.length;
  history.length = 0;
  history.push({
    role: "user",
    content: "## Summary of this conversation (generated via /compact)\n\n" + summary,
  });
  return removed;
}

// ---------------------------------------------------------------------------
// the REPL
// ---------------------------------------------------------------------------
// The caller (cli.ts) has already connected the servers (best-effort) and
// handed us a registry: { views, warnings, keyedViews, byKey }.
export async function startChat({
  registry,
  model,
  base,
  openai,
}: {
  registry: Registry;
  model: string;
  base?: string | null;
  openai?: InstanceType<typeof OpenAI>;
}): Promise<void> {
  const state = await buildChatState({ registry, model, base, openai });
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Tab hints for slash commands (top-level and /schedule + /ralph
    // subcommands); see slashCompletions for the readline contract.
    completer: slashCompletions,
  });
  const spinner = new Spinner();
  const history: ConversationMessage[] = [];
  let exited = false;

  printBanner(state, true);

  const shutdown = () => {
    if (exited) return;
    exited = true;
    spinner.stop();
    try {
      console.log(color("dim", "\nbye.\n"));
    } catch {
      /* terminal may be closed; ignore */
    }
    (async () => {
      try {
        await closeAll(state.registry);
      } catch {
        /* servers may already be gone */
      }
      rl.close();
      process.exit(0);
    })();
  };

  // Re-prompt after a turn completes.
  const loop = async () => {
    if (exited) return;
    rl.question(PROMPT, async (line: string) => {
      if (exited) return;
      const input = line.trim();
      if (input === "") return loop();

      const cmd = input.toLowerCase();
      if (cmd === "/help" || cmd === "/h") {
        process.stdout.write("\n");
        console.log(color("green", "REPL help:\n"));
        console.log(REPLY_HELP);
        return loop();
      }
      if (cmd === "/tools" || cmd === "/t") {
        process.stdout.write("\n");
        printTools(state.registry.keyedViews);
        return loop();
      }
      if (cmd === "/skills" || cmd === "/s") {
        process.stdout.write("\n");
        console.log(color("green", "skills:"));
        if (state.skills.length > 0) {
          for (const s of state.skills) {
            console.log(`  ${s.name} — ${s.description}`);
          }
        } else {
          console.log(color("dim", "  (none found in ./skills/)"));
        }
        return loop();
      }
      if (cmd === "/reset" || cmd === "/clear" || cmd === "/c") {
        process.stdout.write("\n");
        history.length = 0;
        console.log(color("dim", "  history cleared.\n"));
        return loop();
      }
      if (cmd === "/compact" || cmd === "/summarize") {
        // Nothing to compact yet: no model call, so no spinner needed.
        if (history.length < 2) {
          console.log(color("dim", "  nothing to compact.\n"));
          return loop();
        }
        spinner.start("summarizing…");
        const summary = await summarizeHistory(state, history);
        if (!summary) {
          spinner.stop();
          console.log(
            color("dim", "  could not summarize; history unchanged.\n")
          );
          return loop();
        }
        spinner.stopDown();
        const removed = replaceHistoryWithSummary(history, summary);
        console.log(
          color(
            "dim",
            `  compacted ${removed} message(s) -> summary (${summary.length} chars).\n`
          )
        );
        return loop();
      }
      // /schedule — manage the scheduled-job file (add/list/rm). For a recurring
      // job the cron expression is the first 5 whitespace fields; everything after
      // field 5 is the prompt (case preserved). For a one-shot job the first field
      // is a space-free ISO date/time and everything after it is the prompt.
      // parseScheduleCmd returns null for any line that isn't a "/schedule"
      // command, so plain prompts fall through to runTurn below.
      {
        const scheduleParsed = parseScheduleCmd(input);
        if (scheduleParsed !== null) {
          process.stdout.write("\n");
          if (scheduleParsed.kind === "add") {
            try {
              const job = await addJob({
                prompt: scheduleParsed.prompt,
                expr: scheduleParsed.expr,
                at: scheduleParsed.at,
              });
              const when = job.expr ? `cron "${job.expr}"` : `once @ ${job.at}`;
              console.log(
                color(
                  "green",
                  `  added job ${job.id.slice(0, 6)} — ${when}: ${job.prompt}\n`
                )
              );
            } catch (e) {
              console.log(
                color("red", `  ✖ ${e instanceof Error ? e.message : String(e)}\n`)
              );
            }
          } else if (scheduleParsed.kind === "list") {
            const jobs = await listJobs();
            if (jobs.length === 0) {
              console.log(
                color(
                  "dim",
                  "  no scheduled jobs yet — add one with: /schedule add <expr> <prompt>\n"
                )
              );
            } else {
              console.log(`  ${jobs.length} job(s):\n`);
              for (const j of jobs) {
                const last = j.lastRun
                  ? `last: ${j.lastRun.slice(0, 16)} (${j.lastStatus})`
                  : "last: none yet";
                const when =
                  j.expr
                    ? j.expr.padEnd(20)
                    : j.at
                    ? j.at.padEnd(20)
                    : "no schedule".padEnd(20);
                console.log(`  ${j.id.slice(0, 6)}  ${when}  ${j.prompt}`);
                console.log(`${" ".repeat(32)}${last}`);
              }
            }
          } else if (scheduleParsed.kind === "rm") {
            const jobs = await listJobs();
            const matches = jobs.filter(
              (j) => j.id === scheduleParsed.ref || j.id.startsWith(scheduleParsed.ref)
            );
            if (matches.length === 0) {
              console.log(color("dim", `  no such job: ${scheduleParsed.ref}\n`));
            } else if (matches.length > 1) {
              console.log(
                color(
                  "yellow",
                  `  ${matches.length} jobs match prefix "${scheduleParsed.ref}" (ambiguous) — use a longer prefix or the full id\n`
                )
              );
            } else {
              try {
                await removeJob(matches[0].id);
                const when =
                  matches[0].expr
                    ? `cron "${matches[0].expr}"`
                    : `once @ ${matches[0].at}`;
                console.log(
                  color(
                    "green",
                    `  removed job ${matches[0].id.slice(0, 6)} — ${when}\n`
                  )
                );
              } catch (e) {
                console.log(
                  color("red", `  ✖ ${e instanceof Error ? e.message : String(e)}\n`)
                );
              }
            }
          } else if (scheduleParsed.kind === "help") {
            console.log(color("green", "scheduled jobs:\n"));
            console.log(SCHEDULE_HELP);
            console.log();
          } else {
            // kind === "error"
            console.log(color("yellow", `  ${scheduleParsed.message}\n`));
          }
          return loop();
        }
      }
      // /ralph — manage Ralph runs. `plan` hands a drafting prompt to the model.
      let turnInput = input;
      {
        const ralphParsed = parseRalphCmd(input);
        if (ralphParsed !== null) {
          process.stdout.write("\n");
          const res = await runRalphRepl(ralphParsed, state.baseDir);
          if (res.prompt === undefined) {
            if (res.text !== undefined) console.log(color("green", `  ${res.text.replace(/\n/g, "\n  ")}\n`));
            return loop();
          }
          turnInput = res.prompt;
        }
      }
      if (cmd === "/quit" || cmd === "/exit" || cmd === "/q") {
        return shutdown();
      }

      // A chat turn: the model picks tools (MCP or local skills) and the agent
      // loop drives the round to completion.
      const answer = await runTurn(state, turnInput, history, spinner);
      if (answer === null) return loop(); // error already printed; re-prompt

      console.log(color("blue", `  ${answer ? answer : "(no response)"}`));
      console.log(); // blank line between turns
      loop();
    });
  };

  rl.on("SIGINT", shutdown);
  rl.on("close", shutdown);
  process.stdin.on("end", shutdown);

  // Job control: on `fg` after Ctrl-Z, readline's own SIGCONT handler restores
  // raw mode but pauses the input stream and emits `SIGCONT` on the interface,
  // expecting the app to resume it. Without this, stdin stays paused: the REPL
  // looks frozen and typed input only surfaces in the shell after a kill. (Must
  // be `rl.on`, not `process.on`: a process-level listener runs *before*
  // readline's and gets undone by its pause.)
  rl.on("SIGCONT", () => {
    if (exited) return;
    rl.resume();
  });

  loop();
}

// Run a single agent turn for a prompt. The scripted, non-REPL mode selected
// by `slask-client --prompt <text>`. Returns the process exit code: 0 on a
// successful answer, 1 when the turn fails (the error is already printed).
// The caller (cli.js) performs the actual exit so the function is testable
// in-process.
export async function runOneShot({
  registry,
  model,
  base,
  prompt,
  openai,
  quiet,
}: {
  registry: Registry;
  model: string;
  base?: string | null;
  prompt: string;
  openai?: InstanceType<typeof OpenAI>;
  // Omit the startup banner (server/model/tools listing). Used by the
  // scheduler daemon's one-shot children so their logs show just prompt +
  // answer.
  quiet?: boolean;
}): Promise<number> {
  const state = await buildChatState({ registry, model, base, openai });
  if (!quiet) {
    printBanner(state, false);
  }
  console.log(color("dim", "\nprompt: "));
  console.log(color("dim", `  ${prompt}\n`));
  const spinner = new Spinner();
  const history: ConversationMessage[] = [];
  const answer = await runTurn(state, prompt, history, spinner);
  await closeAll(state.registry);
  if (answer === null) {
    return 1;
  }
  console.log(color("blue", `  ${answer ? answer : "(no response)"}`));
  return 0;
}
