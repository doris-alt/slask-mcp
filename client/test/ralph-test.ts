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
  setSpec,
  synthesisPrompt,
  tokenize,
  validateOutputDir,
  workerPrompt,
} from "../ralph.js";
import type { AgentRunArgs, ExecResult } from "../ralph.js";
import { parse } from "../cli.js";

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
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
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
    assert.ok(prompts[1].includes("FAILED verification") && prompts[1].includes("BOOM"));
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
        await callRalphTool(base, "ralph_add_task", { title: "cart model", acceptanceCriteria: ["npm test passes"] });
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

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
