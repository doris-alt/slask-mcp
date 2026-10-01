// agent.ts — the OpenAI + MCP agent loop.
//
// Runs one user turn through an OpenAI Chat Completions "function calling"
// loop: the model decides which tools to call, `callTool` (a resolver supplied
// by the caller) routes the call to the right server, the (text) results are
// appended back to the message history, and the loop repeats until the model
// produces a final answer. A per-turn cap on tool iterations bounds runaway
// loops. Tools may span several servers; their names are whatever the caller
// put in `tools` (raw name, or `<server>__<name>` when names collide).
//
// The model side is any **OpenAI-compatible** chat endpoint:
//   - real OpenAI (default: https://api.openai.com, requires OPENAI_API_KEY)
//   - local servers such as Ollama (no API key needed) — point API_BASE at
//     the host; the SDK is configured to ignore a placeholder key.

import { OpenAI } from "openai";

import { mcpResultToText } from "./client.js";
import type {
  AgentTurnConfig,
  ConversationMessage,
  FunctionToolCall,
  McpToolLike,
  OpenAiFunctionTool,
  ToolCallRecord,
} from "./types.js";

export const DEFAULT_MODEL = "gpt-4o-mini"; // cheap/fast for real OpenAI; override via MODEL/OPENAI_MODEL/--model
export const DEFAULT_API_BASE = "https://api.openai.com"; // normalize to /v1 below
const MAX_TOOL_ITERATIONS = 8; // safety cap: tool round-trips per turn
const MAX_TOKENS = 1024; // hard cap on each completion

// The OpenAI SDK appends /chat/completions to your baseURL, so the base must
// already point at the /v1 root. Normalize any input (with or without /v1,
// with or without a trailing slash) to that form.
function ensureV1Path(base: string): string {
  let url = base.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) {
    url += "/v1";
  }
  return url;
}

// A request is aimed at the real OpenAI service only when the host is
// api.openai.com (independent of path/port). Only that case requires an
// API key; every other (local/compatible) endpoint gets a placeholder key.
function isRealOpenAi(base: string): boolean {
  try {
    return new URL(base).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export const SYSTEM_PROMPT = [
  "You are a helpful agent that answers the user's requests using the tools",
  "passed in via `tools`. Call only tools that appear in that list; never invent",
  "names. Each tool's name is exactly the `name` in the list — when several MCP",
  "servers are connected, tools that would otherwise collide are prefixed with",
  "their server name (e.g. `slask__echo`, `weather__forecast`). Use the exact",
  "names provided.",
  "Use a tool when the user's request needs it; otherwise just answer directly.",
  "Keep answers concise and in the user's language. If a tool call fails, say so",
  "clearly and continue with what you can (do not pretend the tool succeeded).",
].join("\n");

// Resolve the OpenAI client config from env + the (optional) base-url flag.
//
// A local OpenAI-compatible server (e.g. Ollama at http://host:11434) needs
// no API key, so when the target is anything other than the real OpenAI
// endpoint we pass a placeholder key instead of requiring one. Pointing at
// the real OpenAI endpoint without a key is an error.
function resolveApiConfig(base?: string | null): { baseURL: string; apiKey: string } {
  const rawBase = base ?? process.env.API_BASE ?? DEFAULT_API_BASE;
  const key = process.env.OPENAI_API_KEY ?? "";
  const real = isRealOpenAi(rawBase);
  const effectiveKey = key || (real ? "" : "local");
  if (!effectiveKey) {
    throw new Error(
      "OPENAI_API_KEY is not set and the target is the real OpenAI endpoint (" +
        `${DEFAULT_API_BASE}). Set OPENAI_API_KEY to use the real API, or point ` +
        "API_BASE (or --base-url) at an OpenAI-compatible server that needs no " +
        "key (e.g. an Ollama host) to skip the key."
    );
  }
  return { baseURL: ensureV1Path(rawBase), apiKey: effectiveKey };
}

/**
 * Build the OpenAI client. `base` (a `--base-url` flag) takes precedence over
 * `API_BASE`, which defaults to the real OpenAI endpoint.
 */
export function createOpenAiClient({ base }: { base?: string | null }): InstanceType<typeof OpenAI> {
  const { baseURL, apiKey } = resolveApiConfig(base);
  return new OpenAI({ baseURL, apiKey });
}

/**
 * Convert the MCP `tools/list` tools into the OpenAI function-calling `tools`
 * array. The MCP `inputSchema` may carry a `$schema` key, which we strip to
 * avoid strict-mode surprises in OpenAI.
 */
export function mcpToolsToOpenai(mcpTools: McpToolLike[]): OpenAiFunctionTool[] {
  const parametersFromSchema = (schema?: Record<string, unknown> | null) => {
    const p: Record<string, unknown> = { ...(schema ?? {}) };
    delete p.$schema;
    return p;
  };
  return mcpTools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description ?? "",
      parameters: parametersFromSchema(t.inputSchema),
    },
  }));
}

/**
 * Run one user turn.
 *
 * @param cfg
 *   - `tools`    OpenAI-function-shaped array (names are the caller's keys).
 *   - `callTool` resolver: `async (toolName, args) => result`, routed to the
 *     right per-server client.
 * @param requestMessages prior conversation (no system)
 * @param onToolCall optional callback the UI prints a tool trace for each MCP
 *        tool the model calls.
 * @returns the model's final answer.
 */
export async function runAgentTurn(
  cfg: AgentTurnConfig,
  requestMessages: ConversationMessage[],
  onToolCall?: (record: ToolCallRecord) => void,
): Promise<string> {
  const { openai, model, systemPrompt, tools, callTool } = cfg;
  const messages: ConversationMessage[] = [
    { role: "system", content: systemPrompt },
    ...requestMessages,
  ];

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await openai.chat.completions.create({
      model,
      messages,
      tools,
      max_tokens: MAX_TOKENS,
    });
    const choice = res.choices?.[0];
    const message = choice?.message;
    if (!message) {
      // The model returned no message body; nothing to act on this iteration.
      continue;
    }
    const finishReason = choice?.finish_reason;
    const toolCalls = message.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      // Narrow to function tool calls — the only kind we can execute. The SDK
      // tool-call type also covers custom tool calls, which have no `function`
      // and are dropped rather than run.
      const funcCalls: FunctionToolCall[] = toolCalls.filter(
        (tc): tc is FunctionToolCall => tc.type === "function",
      );
      // Emit the assistant turn that requested the tools, then run each one
      // and append its result; loop back for the model's next decision.
      messages.push({
        role: "assistant",
        content: message.content ?? null,
        tool_calls: funcCalls,
      });
      for (const tc of funcCalls) {
        const toolName = tc.function.name;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments ?? "{}");
        } catch {
          args = {};
        }
        let resultText: string;
        try {
          const result = await callTool(toolName, args);
          resultText = mcpResultToText(result);
        } catch (e) {
          // A bad/unknown tool, a transport error, or a 4xx/5xx from the
          // server: feed the failure back to the model instead of crashing the
          // session.
          const msg = e instanceof Error ? e.message : String(e);
          resultText = `ERROR calling ${toolName}: ${msg}`;
        }
        onToolCall?.({ name: toolName, args, resultText });
        messages.push({ role: "tool", tool_call_id: tc.id, content: resultText });
      }
      continue;
    }

    if (finishReason === "length") {
      throw new Error("the response was cut off by the token limit — try a shorter prompt");
    }
    return message.content ?? "";
  }

  throw new Error(`stopped after ${MAX_TOOL_ITERATIONS} tool calls in one turn (safety cap)`);
}
