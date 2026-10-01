// ui.ts — the line-based chat REPL for slask-mcp.
//
// Wraps one or more MCP servers (already connected by cli.ts via servers.ts)
// with the OpenAI agent loop (agent.ts): the user types natural language, the
// model decides which MCP tools to call, the client executes them, results feed
// back, and a final answer is printed. Non-streaming, with a small `thinking…`
// spinner and a dependency-free color/ANSI helper. Built on node:readline only
// (no TUI lib).
//
// REPL commands: /help /h  /tools /t  /reset /clear /c  /quit /exit /q

import { createInterface } from "node:readline";
import type { Writable } from "node:stream";

import { OpenAI } from "openai";
import { hintFor, printTools } from "./client.js";
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
  ConversationMessage,
  Registry,
  ToolCallRecord,
} from "./types.js";

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
// spinner
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

class Spinner {
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
    }
    this.out.write(`\r${" ".repeat(this.padWidth() + 4)}\r`);
  }

  // clear the spinner line and move to a fresh line below it
  stopDown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
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
  "  /reset    clear the conversation history",
  "  /quit     (or /exit, /q, or Ctrl+C) leave the REPL",
  "",
  "Otherwise, just type a request. Examples:",
  "  what time is it?",
  "  echo the word hello",
  "  which tools can I use?",
].join("\n");

// ---------------------------------------------------------------------------
// the REPL
// ---------------------------------------------------------------------------
// The caller (cli.ts) has already connected the servers (best-effort) and
// handed us a registry: { views, warnings, keyedViews, byKey }.
export async function startChat({
  registry,
  model,
  base,
}: {
  registry: Registry;
  model: string;
  base?: string | null;
}): Promise<void> {
  // 1) OpenAI client (chat-only) — fail fast, before touching the server.
  //    `base` (a `--base-url` flag) takes precedence over API_BASE, which
  //    defaults to the real OpenAI endpoint. Local servers (e.g. Ollama)
  //    accept a placeholder key, so no real key is required for them.
  let openai: InstanceType<typeof OpenAI>;
  try {
    openai = createOpenAiClient({ base });
  } catch (e) {
    die(e instanceof Error ? e.message : String(e));
  }

  // 2) Build the (possibly multi-server) tool list.
  const openaiTools = mcpToolsToOpenai(openAiTools(registry));

  // Report any servers we could not reach (they're skipped, not fatal).
  for (const w of registry.warnings) {
    console.error(
      color("red", `  ⚠ could not reach server ${w.name}: ${w.error}${hintFor(w.error)}`)
    );
  }

  // Banner.
  const effectiveBase = base ?? process.env.API_BASE ?? DEFAULT_API_BASE;
  console.log(color("bold", "\nslask-mcp agent\n"));
  for (const v of registry.keyedViews) {
    console.log(`  server : ${color("cyan", v.name)} (${v.kind}) ${v.address}`);
  }
  if (registry.keyedViews.length === 0) {
    console.log(`  server : ${color("dim", "(none reached)")}`);
  }
  console.log(`  model  : ${color("cyan", model)}`);
  console.log(`  api    : ${color("cyan", effectiveBase)}`);
  console.log(
    `  tools  : ${color(
      "cyan",
      openaiTools.length ? openaiTools.map((t) => t.function.name).join(", ") : "(none)"
    )}`
  );
  console.log(color("dim", "\nType a request (e.g. 'what time is it?'), or /help for commands.\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const spinner = new Spinner();
  const history: ConversationMessage[] = [];
  let exited = false;

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
        await closeAll(registry);
      } catch {
        /* servers may already be gone */
      }
      rl.close();
      process.exit(0);
    })();
  };

  // Print a tool trace (called by the agent loop while the spinner is up).
  const onToolCall = ({ name, args, resultText }: ToolCallRecord) => {
    spinner.stopDown();
    console.log(color("yellow", `  ▸ ${name}(${JSON.stringify(args)})`));
    console.log(color("dim", `      ${resultText.replace(/\n/g, "\n      ")}`));
    spinner.start("thinking…");
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
        printTools(registry.keyedViews);
        return loop();
      }
      if (cmd === "/reset" || cmd === "/clear" || cmd === "/c") {
        process.stdout.write("\n");
        history.length = 0;
        console.log(color("dim", "  history cleared.\n"));
        return loop();
      }
      if (cmd === "/quit" || cmd === "/exit" || cmd === "/q") {
        return shutdown();
      }

      // A chat turn: spinner up for the whole round (LLM + any tool calls).
      //
      // The user message is pushed to the history *before* the model is asked,
      // so it responds to the current line — not the previous turn's.
      const userMsg: ConversationMessage = { role: "user", content: input };
      spinner.start("thinking…");
      let answer: string;
      try {
        history.push(userMsg);
        answer = await runAgentTurn(
          {
            openai,
            model,
            systemPrompt: SYSTEM_PROMPT,
            tools: openaiTools,
            callTool: (name, args) => callToolBy(name, registry, args),
          },
          history,
          onToolCall
        );
      } catch (err) {
        spinner.stop();
        // Drop the unprocessed request so a failed turn doesn't pollute history.
        if (history[history.length - 1] === userMsg) history.pop();
        console.log(
          color("red", `${err instanceof Error ? err.message : String(err)}\n`)
        );
        return loop(); // stay alive; re-prompt
      }
      spinner.stopDown();
      console.log(color("blue", `  ${answer ? answer : "(no response)"}`));
      history.push({ role: "assistant", content: answer });
      console.log(); // blank line between turns
      loop();
    });
  };

  rl.on("SIGINT", shutdown);
  rl.on("close", shutdown);
  process.stdin.on("end", shutdown);

  loop();
}
