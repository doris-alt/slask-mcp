// ui.js — the line-based chat REPL for slask-mcp.
//
// Wraps the slask-mcp MCP server (client.js) with the OpenAI agent loop
// (agent.js): the user types natural language, the model decides which MCP
// tools to call, the client executes them, results feed back, and a final
// answer is printed. Non-streaming, with a small `thinking…` spinner and a
// dependency-free color/ANSI helper. Built on node:readline only (no TUI lib).
//
// REPL commands: /help /h  /tools /t  /reset /clear /c  /quit /exit /q

import { createInterface } from "node:readline";

import { close, connect, hintFor, listTools, printTools } from "./client.js";
import {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  createOpenAiClient,
  mcpToolsToOpenai,
  runAgentTurn,
} from "./agent.js";

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
};
const COLOR_ENABLED = process.stdout.isTTY && !("NO_COLOR" in process.env);
const color = (name, s) => (COLOR_ENABLED ? `${PALETTE[name]}${s}${PALETTE.reset}` : s);
const PROMPT = color("cyan", "slask-agent > ");

// ---------------------------------------------------------------------------
// spinner
// ---------------------------------------------------------------------------
const FRAMES = [
  "▋", // ⠋
  "▙", // ⠙
  "▹", // ⠹
  "▸", // ⠸
  "▼", // ⠼
  "▴", // ⠴
  "◦", // ⠦
  "◧", // ⠧
  "◇", // ⠇
  "●", // ⠏
];

class Spinner {
  constructor(out = process.stdout) {
    this.out = out;
    this.timer = null;
    this.label = "";
    this.i = 0;
  }

  start(label = "thinking…") {
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

  padWidth() {
    return this.label ? this.label.length : 0;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function die(msg) {
  console.error(color("red", `\n✖ ${msg}`));
  process.exit(1);
}

const REPLY_HELP = [
  "REPL commands:",
  "  /help     show this help",
  "  /tools    list the slask-mcp tools",
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
export async function startChat({ url, token, model, base }) {
  // 1) OpenAI client (chat-only) — fail fast, before touching the server.
  //    `base` (a `--base-url` flag) takes precedence over API_BASE, which
  //    defaults to the real OpenAI endpoint. Local servers (e.g. Ollama)
  //    accept a placeholder key, so no real key is required for them.
  let openai;
  try {
    openai = createOpenAiClient({ base });
  } catch (e) {
    die(e.message);
  }

  // 2) Connect to the MCP server + read its tools.
  let client;
  let mcpTools;
  try {
    client = await connect({ url, token });
    mcpTools = await listTools(client);
  } catch (e) {
    const message = e.message ?? e.code ?? String(e);
    die(`couldn't reach the slask-mcp server at ${url}${hintFor(message)}`);
  }
  const openaiTools = mcpToolsToOpenai(mcpTools);

  // Banner.
  const effectiveBase = base ?? process.env.API_BASE ?? DEFAULT_API_BASE;
  console.log(color("bold", "\nslask-mcp agent\n"));
  console.log(`  server : ${color("cyan", url)}`);
  console.log(`  model  : ${color("cyan", model)}`);
  console.log(`  api    : ${color("cyan", effectiveBase)}`);
  console.log(`  tools  : ${color("cyan", mcpTools.map((t) => t.name).join(", "))}`);
  console.log(color("dim", "\nType a request (e.g. 'what time is it?'), or /help for commands.\n"));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const spinner = new Spinner();
  const history = [];
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
        await close(client);
      } catch {
        /* server may already be gone */
      }
      rl.close();
      process.exit(0);
    })();
  };

  // Print a tool trace (called by the agent loop while the spinner is up).
  const onToolCall = ({ name, args, resultText }) => {
    spinner.stopDown();
    console.log(color("yellow", `  ▸ ${name}(${JSON.stringify(args)})`));
    console.log(color("dim", `      ${resultText.replace(/\n/g, "\n      ")}`));
    spinner.start("thinking…");
  };

  // Re-prompt after a turn completes.
  const loop = async () => {
    if (exited) return;
    rl.question(PROMPT, async (line) => {
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
        printTools(mcpTools);
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
      spinner.start("thinking…");
      let answer;
      try {
        answer = await runAgentTurn(
          {
            openai,
            model,
            systemPrompt: SYSTEM_PROMPT,
            mcpClient: client,
            mcpTools: openaiTools,
          },
          history,
          onToolCall
        );
      } catch (err) {
        spinner.stop();
        console.log(color("red", `  ✖ ${err.message}\n`));
        return loop(); // stay alive; re-prompt
      }
      spinner.stopDown();
      console.log(color("blue", `  ${answer ? answer : "(no response)"}`));
      history.push({ role: "user", content: input }, { role: "assistant", content: answer });
      console.log(); // blank line between turns
      loop();
    });
  };

  rl.on("SIGINT", shutdown);
  rl.on("close", shutdown);
  process.stdin.on("end", shutdown);

  loop();
}
