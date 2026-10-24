// ralph-test.ts — drive the Ralph loop (ralph.ts) in-process, network-free.
//
// The child agent is faked through the `runAgentFn` seam (it applies the child's
// env, then calls the same ralph tools a real iteration's model would), and the
// shell through `execFn`. Covers: run creation + prd import, task ordering,
// verifier pass/fail (code check, research checker), stop conditions (done /
// max-iterations / stuck), commit on green only, tool role gating, run_command
// allow-list, and the /ralph REPL + CLI parsers.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addTask,
  guardFileCall,
  lastLine,
  limitsOf,
  lintTask,
  planPrompt,
  reopenTask,
  runReport,
  ralphChildEnv,
  requiredToolsForRole,
  restrictToolsForRole,
  roleMayCall,
  SPLIT_READ_BYTES,
  splitTask,
  callRalphTool,
  checkerPrompt,
  createRun,
  deriveDescription,
  formatStatus,
  handleRalphCli,
  MAX_SPEC_BYTES,
  loadConfig,
  loadPrd,
  normalizeTasks,
  outputDirOf,
  parseRalphCmd,
  pickNext,
  readSpecSource,
  ralphTools,
  runRalph,
  runRalphRepl,
  savePrd,
  setSpec,
  splitViaAgent,
  splitterPrompt,
  synthesisPrompt,
  tokenize,
  validateOutputDir,
  workerPrompt,
} from "../ralph.js";
import type { AgentRunArgs, ExecResult } from "../ralph.js";
import { parse } from "../cli.js";
import { Writable } from "node:stream";
import { capText, pruneMessages, runAgentTurn } from "../agent.js";
import { callFileTool, fileTools } from "../files.js";
import type { OpenAI } from "openai";
import { Spinner } from "../ui.js";
import type { ConversationMessage } from "../types.js";

const ENV_KEYS = [
  "SLASK_RALPH_DIR", "SLASK_RALPH_NAME", "SLASK_RALPH_ROLE", "SLASK_RALPH_TASK", "SLASK_RALPH_ALLOW",
];

async function tmp(): Promise<string> {
  const d = join(tmpdir(), `ralph-test-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await mkdir(d, { recursive: true });
  return d;
}

// Run `fn` with the child's env applied to this process (the ralph tools read it).
async function asChild<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set([...ENV_KEYS, ...Object.keys(env)])];
  const saved = keys.map((k) => [k, process.env[k]] as const);
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function readStatusFile(base: string, name: string): Promise<string | null> {
  try {
    return await readFile(join(base, ".slask-ralph", name, "status.json"), "utf8");
  } catch {
    return null;
  }
}

const ok = (output = ""): ExecResult => ({ code: 0, output });
const quiet = () => {};

async function main(): Promise<void> {
  delete process.env.MAX_CONTEXT_TOKENS; // tests must not depend on the developer's .env
  // -- test1: createRun / addTask / pickNext / import ------------------------
  {
    const base = await tmp();
    const prd = await createRun(base, {
      name: "demo",
      mode: "code",
      tasks: [
        { title: "second", priority: 2 },
        { title: "first", priority: 1, acceptanceCriteria: ["a", "b"] },
      ],
    });
    assert.equal(prd.tasks.length, 2);
    assert.equal(pickNext(prd)?.title, "first");
    const t = await addTask(base, "demo", { title: "third" });
    assert.equal(t.id, "T3");
    assert.equal(t.priority, 3);
    await assert.rejects(createRun(base, { name: "demo" }), /already exists/);
    await assert.rejects(createRun(base, { name: "../evil" }), /invalid run name/);
    const imported = normalizeTasks({ userStories: [{ id: "US-1", title: "x", acceptanceCriteria: ["c"], priority: 1, passes: false }] });
    assert.equal(imported[0].id, "US-1");
    assert.throws(() => normalizeTasks({ tasks: [{ title: "a", id: "d" }, { title: "b", id: "d" }] }), /duplicate/);
    console.log("PASS test1 — createRun/addTask/pickNext/import (incl. ralph userStories)");
    await rm(base, { recursive: true, force: true });
  }

  // -- test2: code mode — claim + passing check -> passes, commit on green ----
  {
    const base = await tmp();
    await createRun(base, { name: "c", mode: "code", check: "npm test", tasks: [{ title: "one" }, { title: "two" }] });
    const cmds: string[] = [];
    const execFn = async (cmd: string): Promise<ExecResult> => {
      cmds.push(cmd);
      if (cmd.startsWith("git status")) return ok(" M file.ts\n");
      return ok();
    };
    const runAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      assert.ok(a.prompt.includes("npm test"), "worker prompt mentions the check");
      await asChild(a.env, () => callRalphTool(base, "ralph_complete_task", { summary: "did it" }));
      return ok();
    };
    const out = await runRalph({ base, name: "c", execFn, runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.state, "done");
    assert.equal(out.iterations, 2);
    assert.equal(out.passed, 2);
    assert.equal(cmds.filter((c) => c === "npm test").length, 2);
    assert.equal(cmds.filter((c) => c.startsWith("git commit")).length, 2);
    assert.ok(cmds.some((c) => c.includes("feat: [T1] - one")));
    const progress = await readFile(join(base, ".slask-ralph/c/progress.txt"), "utf8");
    assert.ok(progress.includes("T1 one: PASS") && progress.includes("T2 two: PASS"));
    console.log("PASS test2 — code: claimed + green check -> passes + commit per task");
    await rm(base, { recursive: true, force: true });
  }

  // -- test3: failing check -> no pass, no commit, failure fed to next prompt; stuck
  {
    const base = await tmp();
    await createRun(base, { name: "f", mode: "code", check: "npm test", maxFailures: 2, tasks: [{ title: "bad" }] });
    const cmds: string[] = [];
    const prompts: string[] = [];
    const execFn = async (cmd: string): Promise<ExecResult> => {
      cmds.push(cmd);
      return cmd === "npm test" ? { code: 1, output: "BOOM 3 tests failed" } : ok();
    };
    const runAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      prompts.push(a.prompt);
      await asChild(a.env, () => callRalphTool(base, "ralph_complete_task", { summary: "trust me" }));
      return ok();
    };
    const out = await runRalph({ base, name: "f", execFn, runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.state, "stuck");
		assert.equal(out.iterations, 2);
		assert.equal(out.passed, 0);
		assert.ok(!cmds.some((c) => c.startsWith("git commit")), "no commit on red");
		assert.ok(!prompts[0].includes("FAILED verification"));
		const retryPrompt = prompts.find((p) => p.includes("FAILED verification"));
		assert.ok(retryPrompt?.includes("FAILED verification") && retryPrompt.includes("BOOM"));
		const prd = await loadPrd(base, "f");
		assert.equal(prd.tasks[0].failures, 2);
		console.log("PASS test3 — code: red check -> no pass/commit, failure fed back, stuck after maxFailures");
    await rm(base, { recursive: true, force: true });
  }

  // -- test4: no claim = failure; max-iterations; model "I'm done" text is ignored
  {
    const base = await tmp();
    await createRun(base, { name: "m", mode: "code", maxFailures: 99, maxIterations: 3, tasks: [{ title: "lazy" }] });
    let n = 0;
    const runAgentFn = async (): Promise<ExecResult> => {
      n++;
      return ok("<promise>COMPLETE</promise> all done!");
    };
    const out = await runRalph({ base, name: "m", execFn: async () => ok(), runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.state, "max-iterations");
    assert.equal(n, 3);
    assert.equal(out.passed, 0);
    console.log("PASS test4 — no ralph_complete_task => failure; stops at max iterations");
    await rm(base, { recursive: true, force: true });
  }

  // -- test5: research — checker verdict gates; final synthesis runs ----------
  {
    const base = await tmp();
    await createRun(base, { name: "r", mode: "research", description: "why", tasks: [{ title: "q1", acceptanceCriteria: ["cite"] }] });
    const roles: string[] = [];
    let checks = 0;
    const runAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      roles.push(`${a.env.SLASK_RALPH_ROLE}:${a.prompt.startsWith("You are the CHECKER") ? "check" : a.prompt.startsWith("You are the final") ? "synth" : "work"}`);
      await asChild(a.env, async () => {
        if (a.env.SLASK_RALPH_ROLE === "checker") {
          checks++;
          await callRalphTool(base, "ralph_verdict", checks === 1 ? { pass: false, reason: "no sources" } : { pass: true, reason: "ok" });
        } else {
          await callRalphTool(base, "ralph_complete_task", { summary: "found" });
        }
      });
      return ok();
    };
    const out = await runRalph({ base, name: "r", execFn: async () => ok(), runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.state, "done");
    assert.deepEqual(roles, ["worker:work", "checker:check", "worker:work", "checker:check", "worker:synth"]);
    const prd = await loadPrd(base, "r");
    assert.equal(prd.tasks[0].passes, true);
    console.log("PASS test5 — research: checker reject -> retry -> pass -> synthesis pass");
    await rm(base, { recursive: true, force: true });
  }

  // -- test6: tool role gating + completion only via the run's own task -------
  {
    process.env.SLASK_RALPH_DIR = "";
    delete process.env.SLASK_RALPH_DIR;
    const names = (): string[] => ralphTools().map((t) => t.function.name);
    assert.ok(names().includes("ralph_create") && !names().includes("run_command") && !names().includes("ralph_complete_task"));
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "worker" }, async () => {
      assert.ok(names().includes("run_command") && names().includes("ralph_complete_task") && !names().includes("ralph_start"));
      await assert.rejects(callRalphTool("/x", "ralph_start", { run: "a" }), /not available/);
    });
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "checker" }, async () => {
      assert.deepEqual(names().sort(), ["ralph_status", "ralph_verdict"]);
    });
    console.log("PASS test6 — tools are role-gated (chat / worker / checker)");
  }

  // -- test7: run_command allow-list, no shell, tokenizer ---------------------
  {
    assert.deepEqual(tokenize(`git commit -m "a b" 'c d'`), ["git", "commit", "-m", "a b", "c d"]);
    assert.throws(() => tokenize(`echo "x`), /unterminated/);
    const base = await tmp();
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "worker", SLASK_RALPH_ALLOW: "node" }, async () => {
      const r = await callRalphTool(base, "run_command", { command: `node -e "console.log(1+1)"` });
      assert.match(JSON.stringify(r), /exit 0\\n2/);
      await assert.rejects(callRalphTool(base, "run_command", { command: "rm -rf /" }), /not allowed/);
      await assert.rejects(callRalphTool(base, "run_command", { command: "node -v && ls" }), /no shell/);
    });
    console.log("PASS test7 — run_command: allow-list, no shell operators, quoting");
    await rm(base, { recursive: true, force: true });
  }

  // -- test8: parsers ---------------------------------------------------------
  {
    assert.equal(parseRalphCmd("/schedule list"), null);
    assert.deepEqual(parseRalphCmd("/ralph"), { kind: "help" });
    assert.deepEqual(parseRalphCmd("/ralph init x research"), { kind: "init", name: "x", mode: "research", spec: undefined });
    assert.deepEqual(parseRalphCmd("/ralph init x tasks/p.md"), { kind: "init", name: "x", mode: "code", spec: "tasks/p.md" });
    assert.deepEqual(parseRalphCmd("/ralph init x research tasks/p.md"), { kind: "init", name: "x", mode: "research", spec: "tasks/p.md" });
    assert.equal(parseRalphCmd("/ralph init x a.md b.md")?.kind, "error");
    assert.deepEqual(parseRalphCmd("/ralph check x npm run build && npm test"), { kind: "check", name: "x", command: "npm run build && npm test" });
    assert.deepEqual(parseRalphCmd("/ralph spec x tasks/p.md"), { kind: "spec", name: "x", file: "tasks/p.md" });
    assert.equal(parseRalphCmd("/ralph spec x")?.kind, "error");
    // flags are CLI-only: init/spec reject them with a pointer instead of misreading
    for (const l of ["/ralph init x --spec p.md", "/ralph spec x --file p.md", "/ralph start x --now"]) {
      const r = parseRalphCmd(l);
      assert.equal(r?.kind, "error", l);
      assert.match((r as { message: string }).message, /options are not used in chat/);
    }
    // free text (goal / title / command) may contain dashes
    assert.equal(parseRalphCmd("/ralph check x npm test -- --coverage")?.kind, "check");
    assert.equal(parseRalphCmd("/ralph plan x Fix the -v flag")?.kind, "plan");
    assert.deepEqual(parseRalphCmd("/ralph plan x research Compare A and B"), { kind: "plan", name: "x", mode: "research", goal: "Compare A and B" });
    assert.deepEqual(parseRalphCmd("/ralph add x Do the thing"), { kind: "add", name: "x", title: "Do the thing" });
    assert.equal(parseRalphCmd("/ralph start")?.kind, "error");
    const cfg = parse(["ralph", "init", "x", "--mode", "research", "--check", "make", "--max", "4", "--from", "p.json", "--criteria", "a;b"]);
    assert.deepEqual(cfg.positional, ["ralph", "init", "x"]);
    assert.deepEqual(cfg.ralph, { mode: "research", check: "make", max: "4", from: "p.json", criteria: "a;b" });
    assert.equal(parse(["-C", "/x", "ralph", "list"]).dir, "/x");
    assert.equal(parse(["--dir", "/y", "list"]).dir, "/y");
    assert.deepEqual(parse(["-C", "/x", "ralph", "list"]).positional, ["ralph", "list"]);
    assert.equal(parse(["list"]).dir, null);
    console.log("PASS test8 — /ralph REPL (positional) + CLI flag parsing");
  }

  // -- test9: abort via signal stops the loop ----------------------------------
  {
    const base = await tmp();
    await createRun(base, { name: "s", mode: "code", tasks: [{ title: "a" }, { title: "b" }] });
    const ac = new AbortController();
    const runAgentFn = async (): Promise<ExecResult> => {
      ac.abort();
      return ok();
    };
    const out = await runRalph({ base, name: "s", execFn: async () => ok(), runAgentFn, log: quiet, autoHandlers: false, signal: ac.signal });
    assert.equal(out.state, "stopped");
    await writeFile(join(base, "x"), "");
    console.log("PASS test9 — abort signal stops the loop");
    await rm(base, { recursive: true, force: true });
  }

  // -- test10: research deliverables go to the visible output dir ---------------
  {
    const base = await tmp();
    await createRun(base, { name: "v", mode: "research", description: "g", tasks: [{ title: "q" }] });
    await createRun(base, { name: "v2", mode: "research", outputDir: "reports/v2/", tasks: [{ title: "q" }] });
    assert.equal((await loadConfig(base, "v")).outputDir, "ralph-v");
    assert.equal((await loadConfig(base, "v2")).outputDir, "reports/v2");
    const prompts: string[] = [];
    const runAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      prompts.push(a.prompt);
      await asChild(a.env, async () => {
        if (a.env.SLASK_RALPH_ROLE === "checker") await callRalphTool(base, "ralph_verdict", { pass: true, reason: "ok" });
        else await callRalphTool(base, "ralph_complete_task", { summary: "s" });
      });
      return ok();
    };
    const out = await runRalph({ base, name: "v", execFn: async () => ok(), runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.message, "report: ralph-v/report.md");
    const all = prompts.join("\n");
    assert.ok(all.includes("ralph-v/findings/T1.md") && all.includes("ralph-v/report.md"));
    assert.ok(!all.includes(".slask-ralph/v/findings") && !all.includes(".slask-ralph/v/report.md"));
    assert.ok(prompts[0].includes(".slask-ralph/v/progress.txt"), "loop state stays hidden");
    assert.match(await formatStatus(base, "v"), /output: ralph-v\//);
    for (const bad of ["../x", "/abs", "", ".slask-ralph/x", "a/../b"]) {
      assert.throws(() => validateOutputDir(bad), /output dir/, bad);
    }
    // legacy config (no outputDir) keeps the old hidden location
    assert.equal(outputDirOf("old", {}), ".slask-ralph/old");
    assert.equal(parse(["ralph", "init", "x", "--out", "r/x"]).ralph.out, "r/x");
    console.log("PASS test10 — research findings/report go to the visible output dir; state stays hidden");
    await rm(base, { recursive: true, force: true });
  }

  // -- test11: spec file: copy, derived description, size cap, setSpec, prompts ---
  {
    const base = await tmp();
    const big = "# Big Project\n\nLots of detail. SECRET-MARKER-TEXT\n";
    await writeFile(join(base, "spec.md"), big);
    const spec = await readSpecSource(base, "spec.md");
    const prd = await createRun(base, { name: "sp", mode: "code", check: "npm test", spec, tasks: [{ title: "t" }] });
    assert.equal(prd.description, "Big Project");
    assert.equal(await readFile(join(base, ".slask-ralph/sp/spec.md"), "utf8"), big);
    assert.match(await formatStatus(base, "sp"), /spec: \.slask-ralph\/sp\/spec\.md/);
    const cfg = await loadConfig(base, "sp");
    const task = prd.tasks[0];
    const w = workerPrompt(prd, cfg, task, ".slask-ralph/sp", "ralph-sp", true);
    assert.ok(w.includes(".slask-ralph/sp/spec.md") && !w.includes("SECRET-MARKER-TEXT"), "points at spec, does not inline it");
    assert.ok(!workerPrompt(prd, cfg, task, ".slask-ralph/sp", "ralph-sp", false).includes("spec.md"));
    assert.ok(checkerPrompt(prd, task, "ralph-sp", ".slask-ralph/sp", true).includes("spec.md"));
    assert.ok(synthesisPrompt(prd, ".slask-ralph/sp", "ralph-sp", true).includes("spec.md"));
    assert.deepEqual(deriveDescription("\n\nplain first line\nmore"), "plain first line");
    await setSpec(base, "sp", "# v2\n");
    assert.equal(await readFile(join(base, ".slask-ralph/sp/spec.md"), "utf8"), "# v2\n");
    await writeFile(join(base, "empty.md"), "  \n");
    await assert.rejects(readSpecSource(base, "empty.md"), /empty/);
    await assert.rejects(readSpecSource(base, "nope.md"), /not found/);
    await writeFile(join(base, "huge.md"), "x".repeat(MAX_SPEC_BYTES + 1));
    await assert.rejects(readSpecSource(base, "huge.md"), /max/);
    console.log("PASS test11 — spec: copied, description derived, size-capped, replaceable, referenced (not inlined) in prompts");
    await rm(base, { recursive: true, force: true });
  }

  // -- test12: ralph_configure / chat-role ralph_note / ralph_create specFile ---
  {
    const base = await tmp();
    await writeFile(join(base, "d.md"), "# From File\n");
    delete process.env.SLASK_RALPH_DIR;
    const r = await callRalphTool(base, "ralph_create", { name: "cf", mode: "code", tasks: [], specFile: "d.md" });
    assert.match(JSON.stringify(r), /created/);
    assert.equal((await loadPrd(base, "cf")).description, "From File");
    await callRalphTool(base, "ralph_configure", { run: "cf", check: "make test", branchName: "ralph/cf", maxIterations: 4, description: "goal" });
    const cfg = await loadConfig(base, "cf");
    assert.equal(cfg.check, "make test");
    assert.equal(cfg.maxIterations, 4);
    const prd = await loadPrd(base, "cf");
    assert.equal(prd.branchName, "ralph/cf");
    assert.equal(prd.description, "goal");
    await assert.rejects(callRalphTool(base, "ralph_configure", { run: "cf" }), /nothing to change/);
    await assert.rejects(callRalphTool(base, "ralph_configure", { run: "cf", maxIterations: 0 }), /positive/);
    await callRalphTool(base, "ralph_note", { run: "cf", text: "Assumption: x" });
    assert.match(await readFile(join(base, ".slask-ralph/cf/progress.txt"), "utf8"), /\n- Assumption: x/);
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "worker" }, async () => {
      await assert.rejects(callRalphTool(base, "ralph_configure", { run: "cf", check: "x" }), /not available/);
    });
    console.log("PASS test12 — ralph_configure, chat-role ralph_note, ralph_create specFile");
    await rm(base, { recursive: true, force: true });
  }

  // -- test13: /ralph plan --spec, init --spec --plan, spec subcommand -------------
  {
    const base = await tmp();
    await writeFile(join(base, "prd.md"), "# Shop\n\n- US-1 cart\n");
    assert.equal(parseRalphCmd("/ralph plan")?.kind, "error");
    assert.equal(parseRalphCmd("/ralph plan x")?.kind, "plan");
    assert.match((await runRalphRepl(parseRalphCmd("/ralph plan ghost")!, base)).text ?? "", /no run named "ghost".*\/ralph init ghost/);
    assert.deepEqual(parse(["ralph", "init", "x", "--spec", "p.md", "--plan"]).ralph, { spec: "p.md", plan: true });

    // chat flow: init with spec file, check, spec replace, then plan (interactive prompt)
    assert.match((await runRalphRepl(parseRalphCmd("/ralph init shop prd.md")!, base)).text ?? "", /created run "shop".*with spec/);
    assert.match((await runRalphRepl(parseRalphCmd("/ralph check shop npm test")!, base)).text ?? "", /check for "shop" set/);
    assert.equal((await loadConfig(base, "shop")).check, "npm test");
    await writeFile(join(base, "prd-b.md"), "# Shop B\n");
    assert.match((await runRalphRepl(parseRalphCmd("/ralph spec shop prd-b.md")!, base)).text ?? "", /replaced/);
    assert.equal(await readFile(join(base, ".slask-ralph/shop/spec.md"), "utf8"), "# Shop B\n");
    await setSpec(base, "shop", "# Shop\n\n- US-1 cart\n");
    assert.match((await runRalphRepl(parseRalphCmd("/ralph spec shop nope.md")!, base)).text ?? "", /not found/);
    const res = await runRalphRepl(parseRalphCmd("/ralph plan shop")!, base);
    assert.ok(res.prompt && res.prompt.includes("clarifying questions") && res.prompt.includes(".slask-ralph/shop/spec.md"));
    assert.ok(res.prompt!.includes("ralph_configure") && res.prompt!.includes("Do NOT start the run"));
    assert.equal((await loadPrd(base, "shop")).description, "Shop");
    // new run from a goal (no spec): created with the goal as description
    const g = await runRalphRepl(parseRalphCmd("/ralph plan quick research Compare A and B")!, base);
    assert.ok(g.prompt && g.prompt.includes("Compare A and B"));
    assert.equal((await loadPrd(base, "quick")).mode, "research");

    // headless: init --spec --plan with a fake planner that adds tasks
    let seen = "";
    const planFn = async (name: string, prompt: string): Promise<number> => {
      seen = prompt;
      await asChild({ SLASK_RALPH_NAME: name }, async () => {
        await callRalphTool(base, "ralph_add_task", { title: "cart model", acceptanceCriteria: ["npm test passes", "model file exists"] });
      });
      return 0;
    };
    const code = await handleRalphCli({ positional: ["ralph", "init", "auto"], spec: "prd.md", plan: true }, base, { planFn });
    assert.equal(code, 0);
    assert.ok(!seen.includes("clarifying questions") && seen.includes("cannot ask questions") && seen.includes("Assumption:"));
    const auto = await loadPrd(base, "auto");
    assert.equal(auto.tasks.length, 1);
    assert.equal(auto.tasks[0].passes, false);
    assert.equal((await readStatusFile(base, "auto")), null, "planning does not start the run");
    await assert.rejects(handleRalphCli({ positional: ["ralph", "init", "nospec"], plan: true }, base, { planFn }), /--plan needs/);

    await writeFile(join(base, "prd2.md"), "# Shop v2\n");
    assert.equal(await handleRalphCli({ positional: ["ralph", "spec", "auto", "prd2.md"] }, base), 0);
    assert.equal(await readFile(join(base, ".slask-ralph/auto/spec.md"), "utf8"), "# Shop v2\n");
    console.log("PASS test13 — /ralph init/spec/check/plan (positional), init --spec --plan (headless CLI), spec replace");
    await rm(base, { recursive: true, force: true });
  }

  // -- test14: agent context control: result cap + history pruning; quiet spinner ---
  {
    assert.equal(capText("abc", 0), "abc");
    assert.equal(capText("abc", 10), "abc");
    const c = capText("x".repeat(100), 10);
    assert.ok(c.startsWith("x".repeat(10)) && c.includes("truncated 90 of 100 chars"));
    const call = (id: string): ConversationMessage => ({
      role: "assistant", content: null,
      tool_calls: [{ id, type: "function", function: { name: "f", arguments: "{}" } }],
    });
    const msgs: ConversationMessage[] = [
      { role: "system", content: "s" }, { role: "user", content: "u" },
      call("1"), { role: "tool", tool_call_id: "1", content: "A".repeat(1000) },
      call("2"), { role: "tool", tool_call_id: "2", content: "B".repeat(1000) },
      call("3"), { role: "tool", tool_call_id: "3", content: "C".repeat(1000) },
      call("4"), { role: "tool", tool_call_id: "4", content: "D".repeat(1000) },
    ];
    assert.equal(pruneMessages(msgs, 0), msgs, "budget 0 = off");
    assert.equal(pruneMessages(msgs, 100000), msgs, "under budget = untouched");
    const pr = pruneMessages(msgs, 2500);
    const tool = (i: number) => (pr[i] as { content: string }).content;
    assert.ok(tool(3).includes("removed") && tool(5).includes("removed"), "oldest tool outputs pruned");
    assert.equal(tool(7), "C".repeat(1000), "last two tool outputs kept");
    assert.equal(tool(9), "D".repeat(1000));
    assert.equal(pr.length, msgs.length, "transcript structure preserved");
    assert.equal((msgs[3] as { content: string }).content.length, 1000, "input not mutated");
    // spinner stays silent when stdout is not a TTY (keeps ralph logs clean)
    const chunks: string[] = [];
    const out = new Writable({ write(b, _e, cb) { chunks.push(String(b)); cb(); } });
    const sp = new Spinner(out);
    sp.start("thinking…");
    sp.stopDown();
    assert.equal(chunks.join(""), "", "no spinner output off-TTY");
    console.log("PASS test14 — tool-result cap, history pruning, quiet non-TTY spinner");
  }

  // -- test15: granularity lint, split tool, limits, plan prompt ----------------------
  {
    const coarse = { title: "Collect sources", description: "Save to findings/sources.md and findings/T1.md", acceptanceCriteria: ["lists at least 5 distinct source URLs", "covers 2025"] };
    const ok2 = { title: "Find 2 sources on Mac mini", description: "short", acceptanceCriteria: ["findings/T1.md exists", "2 sources with dates"] };
    assert.deepEqual(lintTask("research", ok2), []);
    const probs = lintTask("research", coarse).join(" | ");
    assert.match(probs, /output files/);
    assert.match(probs, /5\+ items/);
    assert.ok(lintTask("code", { title: "x", acceptanceCriteria: ["a"] }).some((p) => /at least 2/.test(p)));
    assert.ok(lintTask("code", { title: "x", acceptanceCriteria: ["a", "b", "c", "d", "e"] }).some((p) => /max 4/.test(p)));
    assert.ok(lintTask("code", { title: "x", description: "y".repeat(601), acceptanceCriteria: ["a", "b"] }).some((p) => /max 600/.test(p)));
    assert.ok(lintTask("code", { title: "x", acceptanceCriteria: ["10+ endpoints", "b"] }).length > 0);
    assert.deepEqual(lintTask("code", { title: "x", acceptanceCriteria: ["at least 3 tests", "b"] }), []);

    const base = await tmp();
    await createRun(base, { name: "g", mode: "research", tasks: [] });
    delete process.env.SLASK_RALPH_DIR;
    await assert.rejects(callRalphTool(base, "ralph_add_task", { run: "g", ...coarse }), /too coarse for one iteration[\s\S]*Split these/);
    assert.equal((await loadPrd(base, "g")).tasks.length, 0, "coarse task rejected, nothing added");
    await callRalphTool(base, "ralph_add_task", { run: "g", ...ok2 });
    await assert.rejects(callRalphTool(base, "ralph_create", { name: "g2", mode: "research", tasks: [coarse] }), /too coarse/);

    // split: replaces the task, ids/priorities, depth cap, validation
    await createRun(base, { name: "sp2", mode: "research", tasks: [{ title: "a" }, { title: "big" }, { title: "c" }] });
    const subs = [ok2, { ...ok2, title: "Find 2 sources on NVIDIA" }];
    const ids = await splitTask(base, "sp2", "T2", subs);
    assert.deepEqual(ids, ["T2.1", "T2.2"]);
    const after = await loadPrd(base, "sp2");
    assert.deepEqual(after.tasks.map((x) => x.id), ["T1", "T2.1", "T2.2", "T3"]);
    assert.equal(pickNext({ ...after, tasks: after.tasks.filter((x) => x.id !== "T1") })?.id, "T2.1");
    assert.match(await readFile(join(base, ".slask-ralph/sp2/progress.txt"), "utf8"), /T2 big: SPLIT into T2\.1/);
    await splitTask(base, "sp2", "T2.1", subs);
    await assert.rejects(splitTask(base, "sp2", "T2.1.1", subs), /cannot be split further/);
    await assert.rejects(splitTask(base, "sp2", "T3", [ok2]), /2 to 6/);
    await assert.rejects(splitTask(base, "sp2", "T3", [coarse, ok2]), /too coarse/);
    await assert.rejects(splitTask(base, "sp2", "nope", subs), /no task/);
    // tool: only the current task, in worker role
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "worker", SLASK_RALPH_TASK: "T3" }, async () => {
      await callRalphTool(base, "ralph_split_task", { run: "sp2", tasks: subs });
    });
    assert.ok((await loadPrd(base, "sp2")).tasks.some((x) => x.id === "T3.2"));
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "checker" }, async () => {
      await assert.rejects(callRalphTool(base, "ralph_split_task", { tasks: subs }), /not available/);
    });

    // limits + env + configure + status + plan prompt
    assert.deepEqual(limitsOf({}), { contextTokens: 32000, source: "default", toolBudget: 25, contextChars: 80000, resultChars: 8000, maxTokens: 4000, maxItems: 3 });
    assert.equal(limitsOf({ contextTokens: 8000 }).maxTokens, 1024);
    const cfg = await loadConfig(base, "sp2");
    assert.equal(cfg.contextTokens, undefined, "not written unless given: MAX_CONTEXT_TOKENS decides");
    const env = ralphChildEnv("/d", "sp2", cfg, "worker", "T1");
    assert.equal(env.SLASK_CONTEXT_CHARS, "80000");
    assert.equal(env.SLASK_MAX_TOOL_RESULT_CHARS, "8000");
    assert.equal(env.SLASK_MAX_TOOL_ITERATIONS, "25");
    await callRalphTool(base, "ralph_configure", { run: "sp2", contextTokens: 16000, toolBudget: 12 });
    const cfg2 = await loadConfig(base, "sp2");
    assert.equal(cfg2.contextTokens, 16000);
    assert.equal(ralphChildEnv("/d", "sp2", cfg2, "worker", "T1").SLASK_MAX_TOOL_ITERATIONS, "12");
    await assert.rejects(callRalphTool(base, "ralph_configure", { run: "sp2", contextTokens: 10 }), /contextTokens/);
    assert.match(await formatStatus(base, "sp2"), /limits: ~16000 tokens of context, 12 tool calls/);
    const pp = planPrompt(await loadPrd(base, "sp2"), false, false, ".slask-ralph/sp2", cfg2);
    assert.ok(pp.includes("~16000 tokens") && pp.includes("12 tool calls") && pp.includes("10-25 small tasks") && pp.includes("REJECTED"));
    assert.ok(workerPrompt(await loadPrd(base, "sp2"), cfg2, after.tasks[0], ".slask-ralph/sp2", "ralph-sp2").includes("ralph_split_task"));
    assert.equal(lastLine("a\n\u001b[31m  boom happened  \u001b[0m\n\n"), "boom happened");
    console.log("PASS test15 — task lint, ralph_split_task, limits/env/configure, plan prompt sizing");
    await rm(base, { recursive: true, force: true });
  }

  // -- test16: loop: out-of-budget worker -> automatic split (not a failure); real error in reason
  {
    const base = await tmp();
    await createRun(base, { name: "as", mode: "research", maxFailures: 2, maxIterations: 6, tasks: [{ title: "big", acceptanceCriteria: ["a", "b"] }] });
    const roles: string[] = [];
    const small = (t: string) => ({ title: t, description: "d", acceptanceCriteria: ["x.md exists", "cites"] });
    let n = 0;
    const runAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      const role = a.env.SLASK_RALPH_ROLE;
      roles.push(`${role}:${a.env.SLASK_RALPH_TASK}`);
      await asChild(a.env, async () => {
        if (role === "splitter") {
          await callRalphTool(base, "ralph_split_task", { tasks: [small("first half"), small("second half")] });
        } else if (role === "checker") {
          await callRalphTool(base, "ralph_verdict", { pass: true, reason: "ok" });
        } else if (a.env.SLASK_RALPH_TASK === "T1") {
          n++;
        } else if (a.env.SLASK_RALPH_TASK) {
          await callRalphTool(base, "ralph_complete_task", { summary: "done" });
        }
      });
      if (role === "worker" && a.env.SLASK_RALPH_TASK === "T1") {
        return { code: 1, output: "\u001b[31m  the response was cut off by the token limit — try a shorter prompt\u001b[0m\n" };
      }
      return ok();
    };
    const out = await runRalph({ base, name: "as", execFn: async () => ok(), runAgentFn, log: quiet, autoHandlers: false });
    assert.equal(out.state, "done");
    assert.deepEqual(roles.slice(0, 2), ["worker:T1", "splitter:T1"]);
    const prd = await loadPrd(base, "as");
    assert.deepEqual(prd.tasks.map((x) => [x.id, x.passes, x.failures ?? 0]), [["T1.1", true, 0], ["T1.2", true, 0]]);
    assert.equal(n, 1, "the oversized task was attempted once, then split");

    // a plain failure keeps the child's last output line in the reason
    await createRun(base, { name: "pf", mode: "code", maxFailures: 1, tasks: [{ title: "t" }] });
    const bad = async (): Promise<ExecResult> => ({ code: 2, output: "some\n  database exploded\n" });
    const o2 = await runRalph({ base, name: "pf", execFn: async () => ok(), runAgentFn: bad, log: quiet, autoHandlers: false });
    assert.equal(o2.state, "stuck");
    assert.match((await loadPrd(base, "pf")).tasks[0].lastFailure ?? "", /last output: database exploded/);

    // a failed automatic split falls back to a normal failure
    await createRun(base, { name: "nf", mode: "code", maxFailures: 1, tasks: [{ title: "t" }] });
    const tooBig = async (): Promise<ExecResult> => ({ code: 1, output: "stopped after 25 tool calls in one turn (safety cap)" });
    const o3 = await runRalph({ base, name: "nf", execFn: async () => ok(), runAgentFn: tooBig, log: quiet, autoHandlers: false });
    assert.equal(o3.state, "stuck");
    assert.match((await loadPrd(base, "nf")).tasks[0].lastFailure ?? "", /automatic split failed/);

    // manual `ralph split` through the CLI handler
    await createRun(base, { name: "ms", mode: "code", tasks: [{ title: "huge" }] });
    const agentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
      assert.equal(a.env.SLASK_RALPH_ROLE, "splitter");
      assert.ok(a.prompt.includes("SPLITTER"));
      await asChild(a.env, () => callRalphTool(base, "ralph_split_task", { tasks: [small("p1"), small("p2")] }));
      return ok();
    };
    assert.equal(await handleRalphCli({ positional: ["ralph", "split", "ms", "T1"] }, base, { agentFn }), 0);
    assert.deepEqual((await loadPrd(base, "ms")).tasks.map((x) => x.id), ["T1.1", "T1.2"]);
    assert.equal(await handleRalphCli({ positional: ["ralph", "split", "ms", "T1.1"] }, base, { agentFn: async () => ok() }), 1);
    // chat: /ralph split <name> <task-id>
    assert.deepEqual(parseRalphCmd("/ralph  split local-llm T2 "), { kind: "split", name: "local-llm", id: "T2" });
    assert.equal(parseRalphCmd("/ralph split x")?.kind, "error");
    assert.equal(parseRalphCmd("/ralph split x T1 extra")?.kind, "error");
    await createRun(base, { name: "cs", mode: "code", tasks: [{ title: "huge" }] });
    const viaChat = await runRalphRepl(parseRalphCmd("/ralph split cs T1")!, base, async (a) => {
      await asChild(a.env, () => callRalphTool(base, "ralph_split_task", { tasks: [small("c1"), small("c2")] }));
      return ok();
    });
    assert.match(viaChat.text ?? "", /✓ split T1 into T1\.1, T1\.2[\s\S]*T1\.1 c1[\s\S]*T1\.2 c2/);
    assert.match((await runRalphRepl(parseRalphCmd("/ralph split cs T9")!, base, async () => ok())).text ?? "", /no task T9/);
    assert.match((await runRalphRepl(parseRalphCmd("/ralph split cs T1.1")!, base, async () => ok())).text ?? "", /✗ could not split T1\.1: the splitter never called/);
    assert.equal(parse(["ralph", "init", "x", "--context", "16000", "--tool-budget", "12"]).ralph.context, "16000");
    console.log("PASS test16 — auto-split on out-of-budget iterations, real error in failure reason, ralph split CLI");
    await rm(base, { recursive: true, force: true });
  }

  // -- test17: MAX_CONTEXT_TOKENS (.env) bounds every iteration, incl. the splitter ---
  {
    try {
      process.env.MAX_CONTEXT_TOKENS = "131070";
      const lim = limitsOf({});
      assert.deepEqual(lim, { contextTokens: 131070, source: "env", toolBudget: 25, contextChars: 327675, resultChars: 32767, maxTokens: 16383, maxItems: 8 });
      assert.equal(limitsOf({ contextTokens: 16000 }).contextTokens, 16000, "a lower run setting wins");
      assert.equal(limitsOf({ contextTokens: 16000 }).source, "config");
      assert.equal(limitsOf({ contextTokens: 500000 }).contextTokens, 131070, "never above the env window");
      for (const bad of ["abc", "100", "", "1.5"]) {
        process.env.MAX_CONTEXT_TOKENS = bad;
        assert.equal(limitsOf({}).contextTokens, 32000, `invalid MAX_CONTEXT_TOKENS ${JSON.stringify(bad)} ignored`);
      }
      process.env.MAX_CONTEXT_TOKENS = "131070";

      const base = await tmp();
      await createRun(base, { name: "env", mode: "research", tasks: [{ title: "big", acceptanceCriteria: ["a", "b"] }] });
      assert.ok(!("contextTokens" in JSON.parse(await readFile(join(base, ".slask-ralph/env/config.json"), "utf8"))));
      const cfg = await loadConfig(base, "env");
      for (const role of ["worker", "checker", "splitter"] as const) {
        const e = ralphChildEnv("/d", "env", cfg, role, "T1");
        assert.equal(e.SLASK_CONTEXT_CHARS, "327675", role);
        assert.equal(e.SLASK_MAX_TOOL_RESULT_CHARS, "32767", role);
      }
      assert.match(await formatStatus(base, "env"), /limits: ~131070 tokens of context, 25 tool calls per iteration \(MAX_CONTEXT_TOKENS\)/);
      const prd = await loadPrd(base, "env");
      assert.ok(planPrompt(prd, false, false, ".slask-ralph/env", cfg).includes("~131070 tokens"));
      assert.ok(splitterPrompt(prd, cfg, prd.tasks[0], ".slask-ralph/env", "ralph-env", false, "why").includes("~131070 tokens"));
      // task size limits scale with the window: 6 items fine (<= 8), 9 is not
      assert.deepEqual(lintTask("code", { title: "x", acceptanceCriteria: ["at least 6 tests", "b"] }), []);
      assert.ok(lintTask("code", { title: "x", acceptanceCriteria: ["at least 9 tests", "b"] }).some((p) => /at most 8 per task/.test(p)));
      // the splitter child really receives that env
      let seen: Record<string, string> = {};
      const outc = await splitViaAgent(base, "env", "T1", async (a) => {
        seen = a.env;
        return ok();
      });
      assert.equal(outc.ok, false);
      assert.equal(seen.SLASK_RALPH_ROLE, "splitter");
      assert.equal(seen.SLASK_CONTEXT_CHARS, "327675");
      assert.match((await readFile(join(base, ".slask-ralph/env/progress.txt"), "utf8")), /T1 big: SPLIT FAILED/);
      console.log("PASS test17 — MAX_CONTEXT_TOKENS bounds worker/checker/splitter, scales task limits, lower run setting wins");
      await rm(base, { recursive: true, force: true });
    } finally {
      delete process.env.MAX_CONTEXT_TOKENS;
    }
  }

  // -- test18: a split always knows whether it succeeded, and why not -------------
  {
    const base = await tmp();
    const small = (t: string) => ({ title: t, description: "d", acceptanceCriteria: ["x.md exists", "cites"] });
    const coarse = { title: "still big", description: "d", acceptanceCriteria: ["at least 9 items", "b"] };
    await createRun(base, { name: "so", mode: "research", tasks: [{ title: "big" }, { title: "other" }] });

    // success: ids reported, text says so
    const good = await splitViaAgent(base, "so", "T1", async (a) => {
      await asChild(a.env, () => callRalphTool(base, "ralph_split_task", { tasks: [small("p"), small("q"), small("r")] }));
      return ok();
    });
    assert.equal(good.ok, true);
    assert.deepEqual(good.ids, ["T1.1", "T1.2", "T1.3"]);
    assert.equal(good.reason, "");
    assert.match(good.text, /^✓ split T1 into T1\.1, T1\.2, T1\.3/);
    assert.equal(JSON.parse(await readFile(join(base, ".slask-ralph/so/split-result.json"), "utf8")).ok, true);

    // failure: the model's own attempt is rejected as too coarse -> reason carries that, task untouched
    const rejected = await splitViaAgent(base, "so", "T2", async (a) => {
      await asChild(a.env, async () => {
        await assert.rejects(callRalphTool(base, "ralph_split_task", { tasks: [coarse, small("z")] }), /too coarse/);
      });
      return ok();
    });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /ralph_split_task was rejected: too coarse/);
    assert.match(rejected.text, /^✗ could not split T2: ralph_split_task was rejected/);
    assert.ok((await loadPrd(base, "so")).tasks.some((x) => x.id === "T2"), "failed split leaves the task in place");
    assert.match(await readFile(join(base, ".slask-ralph/so/progress.txt"), "utf8"), /T2 other: SPLIT FAILED\nralph_split_task was rejected/);

    // failure: splitter crashed (e.g. context overrun) -> exit code + last output line
    const crashed = await splitViaAgent(base, "so", "T2", async () => ({ code: 1, output: "\u001b[31m the response was cut off by the token limit\u001b[0m\n" }));
    assert.equal(crashed.ok, false);
    assert.equal(crashed.code, 1);
    assert.match(crashed.reason, /exited with code 1: the response was cut off by the token limit/);

    // failure: child exited 0 but never split; stale result from the previous attempt must not leak
    const idle = await splitViaAgent(base, "so", "T2", async () => ok());
    assert.match(idle.reason, /never called ralph_split_task successfully/);

    // precondition errors throw (no agent run)
    await assert.rejects(splitViaAgent(base, "so", "T9", async () => ok()), /no task T9/);
    await assert.rejects(splitViaAgent(base, "so", "T1.1.1", async () => ok()), /no task|cannot be split/);
    const prd = await loadPrd(base, "so");
    prd.tasks.find((x) => x.id === "T2")!.passes = true;
    await savePrd(base, prd);
    await assert.rejects(splitViaAgent(base, "so", "T2", async () => ok()), /already passes/);

    // CLI exit code and chat text follow the outcome
    await createRun(base, { name: "so2", mode: "code", tasks: [{ title: "t" }] });
    assert.equal(await handleRalphCli({ positional: ["ralph", "split", "so2", "T1"] }, base, { agentFn: async () => ok() }), 1);
    assert.match((await runRalphRepl(parseRalphCmd("/ralph split so2 T1")!, base, async () => ok())).text ?? "", /^✗ could not split T1/);

    // loop: failed automatic split shows its reason in lastFailure and in the log
    await createRun(base, { name: "lp", mode: "code", maxFailures: 1, tasks: [{ title: "t" }] });
    const logs: string[] = [];
    const out = await runRalph({
      base, name: "lp", execFn: async () => ok(), log: (l) => logs.push(l), autoHandlers: false,
      runAgentFn: async (a) => {
        if (a.env.SLASK_RALPH_ROLE === "splitter") {
          await asChild(a.env, async () => {
            await assert.rejects(callRalphTool(base, "ralph_split_task", { tasks: [coarse, small("z")] }), /too coarse/);
          });
          return ok();
        }
        return { code: 1, output: "stopped after 25 tool calls in one turn (safety cap)" };
      },
    });
    assert.equal(out.state, "stuck");
    const lf = (await loadPrd(base, "lp")).tasks[0].lastFailure ?? "";
    assert.match(lf, /automatic split failed: ralph_split_task was rejected: too coarse/);
    assert.ok(logs.some((l) => /automatic split of T1 failed: ralph_split_task was rejected/.test(l)));
    console.log("PASS test18 — split outcome: ok+ids on success; precise reason on rejection/crash/no-call; CLI, chat and loop follow it");
    await rm(base, { recursive: true, force: true });
  }

  // -- test19: the splitter is sandboxed to spec.md + prd.json and must end with the tool ---
  {
    const base = await tmp();
    await createRun(base, { name: "sb", mode: "research", spec: "# P\n" + "spec line\n".repeat(5000), tasks: [{ title: "big" }] });
    await mkdir(join(base, "ralph-sb/findings"), { recursive: true });
    await writeFile(join(base, "ralph-sb/findings/T1.md"), "HUGE FINDINGS ".repeat(1000));
    const cfg = await loadConfig(base, "sb");
    const sp = splitterPrompt(await loadPrd(base, "sb"), cfg, (await loadPrd(base, "sb")).tasks[0], ".slask-ralph/sb", "ralph-sb", true, "why");
    assert.ok(/may read ONLY \.slask-ralph\/sb\/prd\.json/.test(sp) && sp.includes("ralph-sb/") && sp.includes("never read the whole spec"));
    assert.ok(!/Partial findings/.test(sp), "no invitation to read findings");
    assert.ok(/do NOT write analysis/i.test(sp));

    const env = ralphChildEnv(join(base, ".slask-ralph/sb"), "sb", cfg, "splitter", "T1");
    await asChild(env, async () => {
      // tool list is restricted
      const names = restrictToolsForRole([
        ...fileTools(), ...ralphTools(),
        { type: "function", function: { name: "search_tools", description: "", parameters: {} } },
        { type: "function", function: { name: "schedule_add", description: "", parameters: {} } },
      ]).map((t) => t.function.name).sort();
      assert.deepEqual(names, ["grep_file", "ralph_split_task", "ralph_status", "read_file"]);
      assert.equal(roleMayCall("search_tools"), false);
      assert.equal(roleMayCall("write_file"), false);
      assert.equal(roleMayCall("ralph_split_task"), true);
      // reads: spec and prd.json only, slices capped
      const g = guardFileCall(base, "read_file", { path: ".slask-ralph/sb/spec.md", bytes: 999999 });
      assert.equal(g.bytes, SPLIT_READ_BYTES);
      assert.equal(guardFileCall(base, "read_file", { path: ".slask-ralph/sb/prd.json" }).bytes, SPLIT_READ_BYTES);
      assert.equal(guardFileCall(base, "read_file", { path: ".slask-ralph/sb/spec.md", bytes: 100 }).bytes, 100);
      guardFileCall(base, "grep_file", { path: "./.slask-ralph/sb/spec.md", pattern: "x" });
      for (const bad of ["ralph-sb/findings/T1.md", ".slask-ralph/sb/progress.txt", ".slask-ralph/sb/iterations/01.log", "ralph-sb", "../x", ".slask-ralph/other/spec.md"]) {
        assert.throws(() => guardFileCall(base, "read_file", { path: bad }), /off limits|may only read/, bad);
      }
      assert.throws(() => guardFileCall(base, "write_file", { path: ".slask-ralph/sb/spec.md" }), /not available to the splitter/);
      assert.throws(() => guardFileCall(base, "edit_file", { path: "x" }), /not available/);
      assert.deepEqual(requiredToolsForRole(), ["ralph_split_task"]);
      // end to end through the real file tool: a capped slice of the big spec
      const slice = await callFileTool(base, "read_file", guardFileCall(base, "read_file", { path: ".slask-ralph/sb/spec.md", bytes: 50000 }));
      assert.ok((slice.content[0] as { text: string }).text.length < SPLIT_READ_BYTES + 200);
    });
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "worker" }, async () => {
      assert.deepEqual(guardFileCall(base, "write_file", { path: "any" }), { path: "any" }, "workers are unrestricted");
      assert.equal(roleMayCall("search_tools"), true);
      assert.equal(requiredToolsForRole(), undefined);
    });
    await asChild({ SLASK_RALPH_DIR: "/x", SLASK_RALPH_ROLE: "checker" }, async () => {
      assert.deepEqual(requiredToolsForRole(), ["ralph_verdict"]);
    });
    assert.equal(requiredToolsForRole(), undefined, "chat has no required tool");
    console.log("PASS test19 — splitter sandbox: restricted tools, spec/prd.json only, capped reads, required tool");
    await rm(base, { recursive: true, force: true });
  }

  // -- test20: agent nudges a role that must end with a tool call --------------------
  {
    type Step = { content?: string; tool?: string; finish?: string };
    const run = async (steps: Step[], requireTool?: string[], toolFails = false) => {
      const sent: ConversationMessage[][] = [];
      let n = 0;
      const openai = {
        chat: { completions: { create: async (req: { messages: ConversationMessage[] }) => {
          sent.push(req.messages.map((m) => ({ ...m })));
          const st = steps[Math.min(n++, steps.length - 1)];
          return { choices: [{ finish_reason: st.finish ?? "stop", message: st.tool
            ? { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: st.tool, arguments: "{}" } }] }
            : { content: st.content ?? "" } }] };
        } } },
      } as unknown as OpenAI;
      const called: string[] = [];
      const answer = await runAgentTurn(
        { openai, model: "m", systemPrompt: "s", tools: [], requireTool,
          callTool: async (name) => {
            called.push(name);
            return { isError: false, content: [{ type: "text", text: toolFails ? "x" : "ok" }] };
          } },
        [{ role: "user", content: "go" }],
      );
      return { answer, sent, called, calls: n };
    };
    // prose first -> nudged -> tool -> done
    const a = await run([{ content: "Here is my long analysis..." }, { tool: "ralph_split_task" }, { content: "done" }], ["ralph_split_task"]);
    assert.deepEqual(a.called, ["ralph_split_task"]);
    assert.equal(a.answer, "done");
    assert.ok(a.sent[1].some((m) => m.role === "user" && /not called ralph_split_task/.test(m.content as string)));
    // reply cut off at max_tokens (finish_reason length) -> truncated text dropped, nudged, then tool
    const b = await run([{ content: "x".repeat(5000), finish: "length" }, { tool: "ralph_split_task" }, { content: "ok" }], ["ralph_split_task"]);
    assert.deepEqual(b.called, ["ralph_split_task"]);
    assert.ok(b.sent[1].some((m) => m.role === "assistant" && m.content === "[reply cut off]"), "long cut-off text is not kept in context");
    assert.ok(b.sent[1].some((m) => m.role === "user" && /cut off because it was too long/.test(m.content as string)));
    // nudges are bounded (2), then the turn just ends
    const c = await run([{ content: "blah" }], ["ralph_verdict"]);
    assert.equal(c.calls, 3);
    assert.deepEqual(c.called, []);
    // a cut-off with nothing required still errors as before; no requirement = no nudge
    await assert.rejects(run([{ content: "x", finish: "length" }]), /cut off by the token limit/);
    const d = await run([{ content: "plain answer" }]);
    assert.equal(d.calls, 1);
    assert.equal(d.answer, "plain answer");
    // an already-satisfied requirement is not nudged
    const e = await run([{ tool: "ralph_verdict" }, { content: "fine" }], ["ralph_verdict"]);
    assert.equal(e.calls, 2);
    console.log("PASS test20 — requireTool: prose/cut-off replies are nudged (max 2) to call the required tool");
  }

  // -- test21: the iteration counter is per task: a pass does not use it up -------------
  {
    const base = await tmp();
    // 5 tasks, maxIterations 3, all pass first time: previously stopped after the 3rd task
    await createRun(base, { name: "pt", mode: "code", maxIterations: 3, tasks: [1, 2, 3, 4, 5].map((i) => ({ title: `task ${i}` })) });
    const logs: string[] = [];
    const claim = async (a: AgentRunArgs): Promise<ExecResult> => {
      await asChild(a.env, () => callRalphTool(base, "ralph_complete_task", { summary: "ok" }));
      return ok();
    };
    const out = await runRalph({ base, name: "pt", execFn: async () => ok(), runAgentFn: claim, log: (l) => logs.push(l), autoHandlers: false });
    assert.equal(out.state, "done");
    assert.equal(out.passed, 5);
    assert.equal(out.iterations, 5, "total worker runs still counted for status/logs");
    const heads = logs.filter((l) => l.startsWith("\n=== iteration"));
    assert.deepEqual(heads.map((h) => h.match(/iteration (\d+)\/3/)![1]), ["1", "1", "1", "1", "1"], "every task starts at iteration 1");
    assert.match(heads[4], /\[run #5\]/);

    // a task needing a retry: 1/3, 2/3, then the NEXT task is back at 1/3
    await createRun(base, { name: "rt", mode: "code", maxIterations: 3, maxFailures: 9, tasks: [{ title: "flaky" }, { title: "next" }] });
    const logs2: string[] = [];
    let flakyTries = 0;
    const flaky = async (a: AgentRunArgs): Promise<ExecResult> => {
      if (a.env.SLASK_RALPH_TASK === "T1" && ++flakyTries < 3) return ok(); // no claim -> failure
      return claim(a);
    };
    const o2 = await runRalph({ base, name: "rt", execFn: async () => ok(), runAgentFn: flaky, log: (l) => logs2.push(l), autoHandlers: false });
    assert.equal(o2.state, "done");
    assert.deepEqual(
      logs2.filter((l) => l.startsWith("\n=== iteration")).map((h) => h.replace(/\n=== iteration (\d+\/3): (\S+).*/, "$2 $1")),
      ["T1 1/3", "T1 2/3", "T1 3/3", "T2 1/3"],
    );

    // one task that never passes still stops after maxIterations of ITS OWN, and names the task
    await createRun(base, { name: "st", mode: "code", maxIterations: 2, maxFailures: 9, tasks: [{ title: "good" }, { title: "bad" }, { title: "never reached" }] });
    let tries = 0;
    const badAgent = async (a: AgentRunArgs): Promise<ExecResult> => {
      if (a.env.SLASK_RALPH_TASK === "T2") {
        tries++;
        return ok();
      }
      return claim(a);
    };
    const o3 = await runRalph({ base, name: "st", execFn: async () => ok(), runAgentFn: badAgent, log: quiet, autoHandlers: false });
    assert.equal(o3.state, "max-iterations");
    assert.equal(tries, 2);
    assert.equal(o3.iterations, 3, "T1 once + T2 twice");
    assert.match(o3.message ?? "", /T2 used all 2 iterations without passing/);
    assert.equal((await loadPrd(base, "st")).tasks.find((x) => x.id === "T3")?.passes, false);
    console.log("PASS test21 — iteration counter is per task (resets for each new task, a pass doesn't use it up)");
    await rm(base, { recursive: true, force: true });
  }

  // -- test22: patch a finished research run: add / reopen a task, redo only that + the report --
  {
    const base = await tmp();
    await createRun(base, { name: "pr", mode: "research", tasks: [{ title: "A" }, { title: "B" }] });
    const seen: string[] = [];
    let reports = 0;
    const agent = async (a: AgentRunArgs): Promise<ExecResult> => {
      const role = a.env.SLASK_RALPH_ROLE;
      const task = a.env.SLASK_RALPH_TASK;
      seen.push(task ? `${role}:${task}` : `${role}:report`);
      await asChild(a.env, async () => {
        if (role === "checker") await callRalphTool(base, "ralph_verdict", { taskId: task, pass: true, reason: "ok" });
        else if (task) await callRalphTool(base, "ralph_complete_task", { summary: "found" });
      });
      if (role === "worker" && !task) {
        await mkdir(join(base, "ralph-pr"), { recursive: true });
        await writeFile(join(base, "ralph-pr", "report.md"), `report v${++reports}`);
      }
      return ok();
    };
    const go = () => runRalph({ base, name: "pr", execFn: async () => ok(), runAgentFn: agent, log: quiet, autoHandlers: false });
    assert.equal((await go()).state, "done");
    assert.deepEqual(seen, ["worker:T1", "checker:T1", "worker:T2", "checker:T2", "worker:report"]);
    assert.equal(await readFile(join(base, "ralph-pr", "report.md"), "utf8"), "report v1");

    // add a task to the finished run (CLI, with --desc): only it + its checker + the report run again
    seen.length = 0;
    assert.equal(await handleRalphCli({ positional: ["ralph", "add", "pr", "C"], criteria: "x;y", desc: "compare against B" }, base), 0);
    const c = (await loadPrd(base, "pr")).tasks.find((t) => t.id === "T3")!;
    assert.equal(c.description, "compare against B");
    assert.equal(c.passes, false);
    assert.equal((await go()).state, "done");
    assert.deepEqual(seen, ["worker:T3", "checker:T3", "worker:report"]);
    assert.equal(await readFile(join(base, "ralph-pr", "report.md"), "utf8"), "report v2");
    assert.equal(await readFile(join(base, "ralph-pr", "report.prev.md"), "utf8"), "report v1", "old report is kept");

    // reopen a passed task: only it is redone
    seen.length = 0;
    await assert.rejects(reopenTask(base, "pr", "T9"), /no task "T9"/);
    assert.equal(await handleRalphCli({ positional: ["ralph", "reopen", "pr", "T1"], note: "missed a source" }, base), 0);
    const t1 = (await loadPrd(base, "pr")).tasks.find((t) => t.id === "T1")!;
    assert.equal(t1.passes, false);
    assert.match(t1.lastFailure ?? "", /missed a source/);
    assert.match(await readFile(join(base, ".slask-ralph", "pr", "progress.txt"), "utf8"), /T1 A: RE-OPENED \(missed a source\)/);
    assert.equal((await go()).state, "done");
    assert.deepEqual(seen, ["worker:T1", "checker:T1", "worker:report"]);

    // report only: no task runs; refuses while a task is pending or in code mode
    seen.length = 0;
    const r = await runReport({ base, name: "pr", runAgentFn: agent, log: quiet });
    assert.ok(r.ok, r.text);
    assert.deepEqual(seen, ["worker:report"]);
    assert.equal(await readFile(join(base, "ralph-pr", "report.md"), "utf8"), "report v4");
    await reopenTask(base, "pr", "T2");
    await assert.rejects(runReport({ base, name: "pr", runAgentFn: agent, log: quiet }), /tasks still pending: T2/);
    await createRun(base, { name: "cc", mode: "code", tasks: [{ title: "x" }] });
    await assert.rejects(runReport({ base, name: "cc", runAgentFn: agent, log: quiet }), /only research runs/);
    // a report agent that writes nothing is reported as a failure
    await rm(join(base, ".slask-ralph", "pr", "run.pid"), { force: true });
    await savePrd(base, { ...(await loadPrd(base, "pr")), tasks: (await loadPrd(base, "pr")).tasks.map((t) => ({ ...t, passes: true })) });
    await rm(join(base, "ralph-pr", "report.md"));
    const bad = await runReport({ base, name: "pr", runAgentFn: async () => ok(), log: quiet });
    assert.equal(bad.ok, false);
    assert.match(bad.text, /report not written/);

    // chat syntax
    assert.deepEqual(parseRalphCmd("/ralph reopen pr T2"), { kind: "reopen", name: "pr", id: "T2" });
    assert.deepEqual(parseRalphCmd("/ralph report pr"), { kind: "report", name: "pr" });
    assert.equal(parseRalphCmd("/ralph reopen pr")?.kind, "error");
    assert.equal(parseRalphCmd("/ralph report")?.kind, "error");
    assert.equal(parse(["ralph", "add", "pr", "t", "--desc", "d"]).ralph.desc, "d");
    assert.equal(parse(["ralph", "reopen", "pr", "T1", "--note", "why"]).ralph.note, "why");
    console.log("PASS test22 — add/reopen a task on a finished research run redoes only it + the report; ralph report");
    await rm(base, { recursive: true, force: true });
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
