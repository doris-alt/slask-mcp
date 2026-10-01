// Stub test: drive runAgentTurn() with a fake OpenAI client but a REAL MCP
// server, so we verify the tool-calling loop (call → execute → feed-back →
// final answer) and that the $schema keys are stripped, without a real API key.
import assert from "node:assert/strict";
import { runAgentTurn, mcpToolsToOpenai, SYSTEM_PROMPT } from "./agent.js";
import { connect, listTools, close, callTool } from "./client.js";
import {
  buildSpecs,
  callToolBy,
  closeAll,
  connectAllServers,
  openAiTools,
} from "./servers.js";

const url = process.env.MCP_URL ?? "http://127.0.0.1:9000/mcp";
const token = process.env.SLASK_MCP_TOKEN ?? null;
console.log("using MCP at", url, token ? "(with Bearer token)" : "(no auth)");

let client;
try {
  client = await connect({ url, token });
} catch (e) {
  console.error("could not connect:", e.message);
  process.exit(2);
}

const mcpTools = await listTools(client);
const openaiTools = mcpToolsToOpenai(mcpTools);

// --- $schema must be stripped; tool shape must be right ---
const mcpBy = new Map(mcpTools.map((t) => [t.name, t]));
assert(openaiTools.length === mcpTools.length, `mismatch ${openaiTools.length} vs ${mcpTools.length}`);
for (const t of openaiTools) {
  assert(t.type === "function", "type should be 'function'");
  const mcp = mcpBy.get(t.function.name);
  assert(mcp, `openai tool name ${t.function.name} not in mcp tools`);
  assert(mcpTools.some((x) => x.name === t.function.name), "openai tool should correspond to a mcp tool");
  assert(t.function.parameters.$schema === undefined,
    `$schema leaked into ${t.name}: ${JSON.stringify(t.function.parameters.$schema)}`);
  assert(t.function.description === mcp.description, "description mismatch for " + t.function.name);
  assert(t.function.parameters && typeof t.function.parameters === "object", "bad parameters for " + t.function.name);
}
console.log("openai tools:", openaiTools.map((t) => t.function.name).join(", "));

// A fake OpenAI client: `create` is scripted per round.
function makeFakeModel(script, record) {
  let n = 0;
  return {
    chat: {
      completions: {
        async create(req) {
          n++;
          if (record) record(n, req.messages);
          const expected = script(n);
          assert(expected !== undefined, `no scripted response for round ${n}`);
          return expected;
        },
      },
    },
  };
}

const toolCall = (id, name, args) => ({
  id, type: "function", function: { name, arguments: args },
});
const choice = (message, finish_reason) => ({
  choices: [{ message: { role: "assistant", ...message }, finish_reason }],
});

// ---- Test 1: single tool call then final answer --------------------------------
const cfg = (openai) => ({ openai, model: "gpt-4o-mini", systemPrompt: SYSTEM_PROMPT, tools: openaiTools, callTool: (name, args) => callTool(client, name, args) });
let spy1 = [];
const fake1 = makeFakeModel((n) => {
  if (n === 1) return choice({ tool_calls: [toolCall("c1", "current_time_utc", "{}")] }, "tool_calls");
  if (n === 2) return choice({ content: "The UTC time is right now, per current_time_utc." }, "stop");
  throw new Error(`unexpected round ${n}`);
});
const ans1 = await runAgentTurn(cfg(fake1), [], (tc) => spy1.push(tc));
assert(spy1.length === 1, `expected 1 tool call, got ${spy1.length}`);
assert(spy1[0].name === "current_time_utc", `tool was ${spy1[0].name}`);
assert(spy1[0].args === {} || JSON.stringify(spy1[0].args) === "{}", `bad args: ${JSON.stringify(spy1[0].args)}`);
assert(/^2026-/.test(spy1[0].resultText), `tool result not a UTC time: ${spy1[0].resultText}`);
assert(ans1, "expected a non-empty answer");
console.log("PASS test1 — answer:", JSON.stringify(ans1), "| tool:", spy1[0].name, "→", spy1[0].resultText);

// ---- Test 2: two tool calls in one batch, then a final answer ------------
let spy2 = [];
const fake2 = makeFakeModel((n) => {
  if (n === 1)
    return choice({ tool_calls: [
      toolCall("d1", "echo", '{"message":"hello"}'),
      toolCall("d2", "current_time_utc", "{}"),
    ] }, "tool_calls");
  if (n === 2)
    return choice({ content: "Echo returned hello and the clock is set." }, "stop");
  throw new Error(`unexpected round ${n}`);
});
const ans2 = await runAgentTurn(cfg(fake2), [], (tc) => spy2.push(tc));
assert(spy2.length === 2, `expected 2 tool calls, got ${spy2.length}`);
const names = spy2.map((t) => t.name).sort();
assert(names.join(",") === "current_time_utc,echo", `got ${names.join(",")}`);
const echo = spy2.find((t) => t.name === "echo");
assert(echo.args.message === "hello", `echo args: ${JSON.stringify(echo.args)}`);
assert(echo.resultText === "hello", `echo result: ${JSON.stringify(echo.resultText)}`);
assert(/^2026-/.test(spy2.find((t) => t.name === "current_time_utc").resultText), "bad time");
assert(ans2, "expected a non-empty answer");
console.log("PASS test2 — answers:", JSON.stringify(ans2));

// ---- Test 3: multi-turn history (2nd turn reuses history) ------------
let spy3 = [];
const msgCounts = [];
const seenMessages = [];
const fake3 = makeFakeModel(
  (n) => {
    if (n === 1) return choice({ tool_calls: [toolCall("e1", "echo", '{"message":"one"}')] }, "tool_calls");
    if (n === 2) return choice({ content: "first turn: one" }, "stop");
    // 2nd user turn:
    if (n === 3) return choice({ tool_calls: [toolCall("e3", "echo", '{"message":"two"}')] }, "tool_calls");
    if (n === 4) return choice({ content: "second turn: two" }, "stop");
    throw new Error(`unexpected round ${n}`);
  },
  (n, msgs) => {
    msgCounts.push(msgs.length);
    seenMessages.push(msgs);
  }
);
const history = [];
const a = await runAgentTurn(cfg(fake3), [], (tc) => spy3.push(tc));
history.push({ role: "user", content: "turn 1" }, { role: "assistant", content: a });
const b = await runAgentTurn(cfg(fake3), [...history, { role: "user", content: "turn 2" }], (tc) => spy3.push(tc));
// one tool call per turn => 2 total
assert(spy3.length === 2, `expected 2 tool calls total (one per turn), got ${spy3.length}`);
assert(a === "first turn: one" && b === "second turn: two", `answers: ${a} / ${b}`);
assert(
  msgCounts[2] > msgCounts[0],
  `turn 2 first call (${msgCounts[2]} msgs) should exceed turn 1 first call (${msgCounts[0]} msgs) via history`
);
// turn 2's first model call must include turn 1's assistant answer (real history reuse)
assert(
  seenMessages[2].some((m) => m.role === "assistant" && m.content === a),
  "turn 2 did not receive turn 1's assistant answer in its context"
);
console.log("PASS test3 — multi-turn history works (turn 2 saw", msgCounts[2], "msgs incl. prior answer)");

// ---- Test 4: tool that doesn't exist → error fed back, final answer ----------
let spy4 = [];
const fake4 = makeFakeModel((n) => {
  if (n === 1) return choice({ tool_calls: [toolCall("f1", "no_such_tool", '{"x":1}')] }, "tool_calls");
  if (n === 2) return choice({ content: "The tool failed, but I'm sorry!" }, "stop");
  throw new Error(`unexpected round ${n}`);
});
const ans4 = await runAgentTurn(cfg(fake4), [], (tc) => spy4.push(tc));
assert(spy4.length === 1, `expected 1, got ${spy4.length}`);
assert(/ERROR calling no_such_tool/i.test(spy4[0].resultText), `no error: ${spy4[0].resultText}`);
assert(ans4, "expected a non-empty answer after a tool failure");
console.log("PASS test4 — unknown tool error fed back, session survives");

// ---- Test 5: multi-server collision — same server under two names; shared
// tool names get the <serverName>__<toolName> prefix, and each key routes to
// its server. -------------------------------------------
{
  const specs = buildSpecs({
    defaultSpec: null,
    configServers: [
      { name: "weather", kind: "http", url, token },
      { name: "calendar", kind: "http", url, token },
    ],
  });
  const registry = await connectAllServers(specs);
  assert(registry.views.length === 2, `expected 2 connected servers, got ${registry.views.length}`);
  const names = openAiTools(registry).map((t) => t.name);
  assert(names.includes("weather__current_time_utc"), `missing weather__current_time_utc: ${names.join(", ")}`);
  assert(names.includes("calendar__current_time_utc"), `missing calendar__current_time_utc: ${names.join(", ")}`);
  assert(!names.includes("current_time_utc"), "shared name should be namespaced");
  const res = await callToolBy("weather__current_time_utc", registry, {});
  assert(/^2026-/.test(res.content[0].text ?? ""), `weather__current_time_utc bad: ${JSON.stringify(res)}`);
  console.log("PASS test5 — collision namespacing:", names.join(", "));
  await closeAll(registry);
}

console.log("\nALL AGENT-LOOP STUB TESTS PASSED");
await close(client);
process.exit(0);