// schedule-test.ts — drive the scheduler (schedule.ts) in-process, fully
// network-free.
//
// No live MCP server and no model endpoint. Storage and daemon tests use the
// `scheduleFn` / `runJobFn` / `log` / `pollMs` / `autoHandlers` seams injected
// into `runScheduler`; the quiet-mode test injects a scripted fake OpenAI client
// through the `openai` seam in `runOneShot` (mirroring ui-stub-test.ts). A
// fresh empty working dir (no ./skills/) keeps `discoverSkills` empty.
//
// Covers:
//   * storage: load on missing file -> []; add persists (id/expr/prompt) + file
//     is valid JSON; remove works; removing a nonexistent id -> "no such job";
//     invalid cron expr rejected with no file written.
//   * CLI parse: schedule / add / list / rm arg shapes land in `positionals`.
//   * daemon: injected cron engine records scheduled exprs; slow runs
//     serialize FIFO (no overlap); a fired job records lastStatus=ok + lastRun;
//     live-sync (fast pollMs) adds a job -> scheduled, removes a job -> stopped.
//   * update: updateJob (expr/prompt/both, missing-field, unknown-id, bad-cron
//     guards); schedule tools (list/add/update/remove) return CallToolResult
//     text with full ids; the daemon reschedules on an expr change and fires
//     with the fresh (re-read) prompt.
//   * quiet: runOneShot({quiet: true}) omits the startup banner.

import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addJob,
  callScheduleTool,
  loadJobs,
  listJobs,
  removeJob,
  runScheduler,
  scheduleSystemBlock,
  scheduleTools,
  updateJob,
} from "../schedule.js";
import type { ScheduleJob } from "../schedule.js";
import { parse } from "../cli.js";
import { parseScheduleCmd, runOneShot } from "../ui.js";
import { textFrom } from "../client.js";

import type { OpenAI } from "openai";
import type {
  CallToolResult,
  Client,
  Registry,
  ServerView,
  Tool,
} from "../types.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// scripted fake OpenAI (same shape as ui-stub-test.ts)
// ---------------------------------------------------------------------------
type FakeOpenAI = InstanceType<typeof OpenAI>;

function makeFakeModel(script: (n: number) => any): unknown {
  let n = 0;
  return {
    chat: {
      completions: {
        async create(req: any) {
          n++;
          const expected = script(n);
          assert(expected !== undefined, `no scripted response for round ${n}`);
          return expected;
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// hand-faked Registry (no real connection) — copied from ui-stub-test.ts
// ---------------------------------------------------------------------------
function mkTool(name: string): Tool {
  return {
    name,
    title: name,
    description: `dummy ${name}`,
    inputSchema: { type: "object" },
  } as Tool;
}

function makeClient(viewLabel: string): {
  calls: { name: string; args: Record<string, unknown> }[];
  client: Client;
} {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client: Client = {
    callTool: async (req: { name?: string; arguments?: Record<string, unknown> }) => {
      calls.push({ name: req.name ?? "?", args: req.arguments ?? {} });
      return {
        isError: false,
        content: [{ type: "text", text: `${viewLabel}:${req.name ?? "?"}` }],
      } as CallToolResult;
    },
    close: async () => {
      /* nothing */
    },
  } as unknown as Client;
  return { calls, client };
}

function makeRegistry(tools: Tool[]): Registry {
  const { client } = makeClient("fake");
  const view: ServerView = {
    name: "fake",
    kind: "http",
    client,
    address: "http://127.0.0.1:9000/mcp",
    tools,
    keyedTools: tools.map((t) => ({ key: t.name, tool: t })),
  };
  const byKey = new Map<string, { view: ServerView; tool: Tool }>();
  for (const { key, tool } of view.keyedTools) byKey.set(key, { view, tool });
  const registry: Registry = {
    views: [view],
    warnings: [],
    keyedViews: [view],
    byKey,
  };
  return registry;
}

// ---------------------------------------------------------------------------
// stdout capture (covers console.log and the spinner, both routing through
// process.stdout.write)
// ---------------------------------------------------------------------------
function captureStdout(): { text: () => string; stop: () => void } {
  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    chunks.push(chunk.toString());
    return origWrite(chunk, ...rest);
  };
  return {
    text: () => chunks.join(""),
    stop: () => {
      (process.stdout as any).write = origWrite;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake cron engine: records scheduled exprs and lets the test trigger a
// "fire" (which invokes the daemon's per-job callback). Keys by expr (tests
// use unique exprs per job). `stopCount` / `stopped` track task stop() calls.
// ---------------------------------------------------------------------------
function makeFakeCron() {
  const cbs = new Map<string, () => void>();
  const exprs: string[] = [];
  const stopped: string[] = [];
  let stopCount = 0;
  const scheduleFn: (expr: string, callback: () => void) => {
    stop: () => void | Promise<void>;
  } = (expr, callback) => {
    exprs.push(expr);
    cbs.set(expr, callback);
    return {
      stop: async () => {
        stopCount += 1;
        stopped.push(expr);
        cbs.delete(expr);
        const i = exprs.indexOf(expr);
        if (i >= 0) exprs.splice(i, 1);
      },
    };
  };
  const fire = (expr: string) => {
    const cb = cbs.get(expr);
    if (!cb) throw new Error(`no scheduled expr "${expr}"`);
    cb();
  };
  const reset = () => {
    cbs.clear();
    exprs.length = 0;
    stopped.length = 0;
    stopCount = 0;
  };
  return { scheduleFn, fire, exprs, stopped, stopCount, reset };
}

// RunJobFn that records completions and flags any *overlapping* runs (two
// runs active at once). A single-threaded daemon that serializes runs should
// never set `overlapped`.
function makeRunJobFn(
  rec: { ran: string[]; overlapped: boolean },
  delayMs: number,
  code: number = 0,
): (job: ScheduleJob) => Promise<number> {
  let active = 0;
  return async (job: ScheduleJob) => {
    active += 1;
    rec.overlapped = rec.overlapped || active > 1;
    await sleep(delayMs);
    active -= 1;
    rec.ran.push(job.id.slice(0, 6));
    return code;
  };
}

// Poll (sync or async) a condition until it's true or the timeout expires.
function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  stepMs = 10,
): Promise<void> {
  return new Promise((r, reject) => {
    let ticks = 0;
    const check = async () => {
      const ok = await cond();
      if (ok) return r();
      ticks += 1;
      if (ticks * stepMs >= timeoutMs) return reject(new Error("waitFor timeout"));
      await sleep(stepMs);
      void check();
    };
    void check();
  });
}

// ---------------------------------------------------------------------------
// Work from a fresh, empty cwd so discoverSkills finds nothing.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const workDir = join(
  tmpdir(),
  `slask-schedule-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
);
await mkdir(workDir, { recursive: true });
process.chdir(workDir);
try {
  // ---- Test 1: loadJobs on a missing file -> [] ---------------------------
  {
    const file = join(workDir, "missing.json");
    const jobs = await loadJobs(file);
    assert(jobs.length === 0, `missing file -> [], got ${jobs.length}`);
    console.log("PASS test1 — loadJobs missing file -> []");
  }

  // ---- Test 2: addJob persists id/expr/prompt; file is valid JSON ----------
  {
    const file = join(workDir, "add.json");
    const job = await addJob("*/5 * * * *", "say hi", file);
    assert(job.id.length > 0, `id non-empty: ${JSON.stringify(job.id)}`);
    assert(job.expr === "*/5 * * * *", `expr: ${JSON.stringify(job.expr)}`);
    assert(job.prompt === "say hi", `prompt: ${JSON.stringify(job.prompt)}`);
    assert(job.createdAt, `createdAt set: ${JSON.stringify(job.createdAt)}`);
    const loaded = await listJobs(file);
    assert(loaded.length === 1, `loaded 1 job, got ${loaded.length}`);
    assert(loaded[0].id === job.id, `persisted id matches`);
    assert(loaded[0].expr === job.expr, `persisted expr matches`);
    assert(loaded[0].prompt === job.prompt, `persisted prompt matches`);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert(
      Array.isArray(parsed.jobs) && parsed.jobs.length === 1,
      `file is { jobs: [ … ] }: ${JSON.stringify(parsed)}`
    );
    console.log("PASS test2 — addJob persists id/expr/prompt; file is valid JSON");
  }

  // ---- Test 3: removeJob removes the job -----------------------------------
  {
    const file = join(workDir, "rm.json");
    const job = await addJob("* * * * *", "boom", file);
    const before = await listJobs(file);
    assert(before.length === 1, `before remove: 1, got ${before.length}`);
    await removeJob(job.id, file);
    const after = await listJobs(file);
    assert(after.length === 0, `after remove: 0, got ${after.length}`);
    console.log("PASS test3 — removeJob removes the job");
  }

  // ---- Test 4: removeJob nonexistent id -> "no such job", file unchanged ---
  {
    const file = join(workDir, "rmnope.json");
    await addJob("* * * * *", "boom", file);
    let err = "";
    try {
      await removeJob("definitely-not-a-real-id", file);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err.includes("no such job"), `error: ${JSON.stringify(err)}`);
    const after = await listJobs(file);
    assert(after.length === 1, `file still has the original job`);
    console.log("PASS test4 — removeJob nonexistent id -> 'no such job', file unchanged");
  }

  // ---- Test 5: addJob rejects an invalid cron expr without writing a file ---
  {
    const file = join(workDir, "invalid.json");
    let err = "";
    try {
      await addJob("not-a-cron-expr!!!", "hi", file);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err.includes("invalid cron expression"), `error: ${JSON.stringify(err)}`);
    assert(
      err.includes("5 fields"),
      `mentions the 5-field format: ${JSON.stringify(err)}`
    );
    let exists = true;
    try {
      await readFile(file, "utf8");
    } catch {
      exists = false;
    }
    assert(!exists, `no file written for an invalid cron expr`);
    console.log("PASS test5 — addJob rejects invalid cron expr, no file written");
  }

  // ---- Test 6: CLI parse — schedule / add / list / rm arg shapes ----------
  {
    const c1 = parse(["schedule"]);
    assert(c1.positional.join(" ") === "schedule", `schedule: ${JSON.stringify(c1.positional)}`);

    const c2 = parse(["schedule", "add", "*/5 * * * *", "say hi"]);
    assert(c2.positional[0] === "schedule", `add pos0`);
    assert(c2.positional[1] === "add", `add pos1`);
    assert(c2.positional[2] === "*/5 * * * *", `add expr: ${JSON.stringify(c2.positional[2])}`);
    assert(c2.positional[3] === "say hi", `add prompt: ${JSON.stringify(c2.positional[3])}`);

    const c3 = parse(["schedule", "list"]);
    assert(c3.positional[1] === "list", `list pos1`);

    const c4 = parse(["schedule", "rm", "abc123"]);
    assert(c4.positional[1] === "rm", `rm pos1`);
    assert(c4.positional[2] === "abc123", `rm id: ${JSON.stringify(c4.positional[2])}`);

    console.log("PASS test6 — schedule CLI parse shapes (schedule/add/list/rm)");
  }

  // ---- Test 7: slow runs serialize FIFO (no overlap) ----------------------
  {
    const file = join(workDir, "serial.json");
    const jobA = await addJob("59 * * * *", "jobA prompt", file);
    const jobB = await addJob("58 * * * *", "jobB prompt", file);
    const cron = makeFakeCron();
    const rec: { ran: string[]; overlapped: boolean; started: string[] } = {
      ran: [],
      overlapped: false,
      started: [],
    };
    let active = 0;
    let jobAStarted = false;
    // runJobFn that records run starts and flags overlapping runs (returns exit code).
    const slowFn = (job: ScheduleJob) => {
      active += 1;
      rec.overlapped = rec.overlapped || active > 1;
      rec.started.push(job.id.slice(0, 6));
      if (job.id === jobA.id) jobAStarted = true;
      return new Promise<number>((r) =>
        setTimeout(() => {
          active -= 1;
          rec.ran.push(job.id.slice(0, 6));
          r(0);
        }, 150)
      );
    };
    const handle = await runScheduler({
      file,
      pollMs: 5000,
      scheduleFn: cron.scheduleFn,
      runJobFn: slowFn,
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.length === 2, 1000);
    const jobAid = jobA.id.slice(0, 6);
    const jobBid = jobB.id.slice(0, 6);
    await cron.fire("59 * * * *"); // fire jobA first
    // Wait until jobA's run has actually started, so the re-read/queue
    // races cannot reverse the order; then fire jobB (which must queue).
    await waitFor(() => jobAStarted, 500);
    await cron.fire("58 * * * *"); // fire jobB second (should queue)
    await waitFor(() => rec.ran.length === 2, 3000);
    assert(rec.overlapped === false, "two runs overlapped (serialization broken)");
    assert(rec.ran[0] === jobAid, `FIFO: first run jobA, got [${rec.ran.join(", ")}]`);
    assert(rec.ran[1] === jobBid, `FIFO: second run jobB, got [${rec.ran.join(", ")}]`);
    await handle.stop();
    console.log("PASS test7 — slow runs serialize FIFO (no overlap)");
  }

  // ---- Test 8: a fired job records lastStatus=ok + lastRun in the file ----
  {
    const file = join(workDir, "status.json");
    const job = await addJob("1 * * * *", "status prompt", file);
    const cron = makeFakeCron();
    const handle = await runScheduler({
      file,
      pollMs: 5000,
      scheduleFn: cron.scheduleFn,
      runJobFn: async () => 0,
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.includes("1 * * * *"), 1000);
    await cron.fire("1 * * * *");
    await waitFor(
      async () =>
        (await listJobs(file)).some(
          (j) => j.id === job.id && j.lastStatus === "ok" && j.lastRun,
        ),
      2000,
    );
    const jobs = await listJobs(file);
    assert(
      jobs.some((j) => j.id === job.id && j.lastStatus === "ok" && j.lastRun),
      `lastStatus=ok + lastRun set: ${JSON.stringify(jobs)}`
    );
    await handle.stop();
    console.log("PASS test8 — fired job records lastStatus=ok + lastRun");
  }

  // ---- Test 9: a failing run records lastStatus=failed --------------------
  {
    const file = join(workDir, "fail.json");
    const job = await addJob("1 * * * *", "fail prompt", file);
    const cron = makeFakeCron();
    const handle = await runScheduler({
      file,
      pollMs: 5000,
      scheduleFn: cron.scheduleFn,
      runJobFn: async () => 3, // non-zero child exit code
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.includes("1 * * * *"), 1000);
    await cron.fire("1 * * * *");
    await waitFor(
      async () =>
        (await listJobs(file)).some((j) => j.id === job.id && j.lastStatus === "failed"),
      2000,
    );
    const jobs = await listJobs(file);
    assert(
      jobs.some((j) => j.id === job.id && j.lastStatus === "failed"),
      `lastStatus=failed: ${JSON.stringify(jobs)}`
    );
    await handle.stop();
    console.log("PASS test9 — failing run records lastStatus=failed");
  }

  // ---- Test 10: live-sync — add -> scheduled, rm -> stopped (fast poll) ---
  {
    const cron = makeFakeCron();
    const file = join(workDir, "sync.json");
    // Start the daemon with jobA already present.
    await addJob("1 * * * *", "jobA", file);
    const handle = await runScheduler({
      file,
      pollMs: 100, // fast polling for the test
      scheduleFn: cron.scheduleFn,
      runJobFn: async () => 0,
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.includes("1 * * * *"), 1000);

    // Add jobB while the daemon runs (simulating `schedule add`).
    const jobB = await addJob("2 * * * *", "jobB", file);
    await waitFor(() => cron.exprs.includes("2 * * * *"), 1000);
    assert(cron.exprs.includes("2 * * * *"), "jobB scheduled within a poll");

    // Remove jobB while the daemon runs (simulating `schedule rm`).
    await removeJob(jobB.id, file);
    await waitFor(() => !cron.exprs.includes("2 * * * *"), 1000);
    assert(!cron.exprs.includes("2 * * * *"), "jobB unscheduled within a poll");
    assert(cron.stopped.includes("2 * * * *"), "jobB task stop() was called");
    await handle.stop();
    assert(cron.exprs.length === 0, `after shutdown no exprs left: ${JSON.stringify(cron.exprs)}`);
    console.log("PASS test10 — live-sync: add -> scheduled, rm -> stopped, within pollMs");
  }

  // ---- Test 11: quiet runOneShot omits the startup banner -----------------
  {
    const registry = makeRegistry([mkTool("echo")]);
    const out = captureStdout();
    const fake = makeFakeModel((n) => {
      if (n === 1) return {
        choices: [{ message: { role: "assistant", content: "Hello, hi." }, finish_reason: "stop" }],
      };
      throw new Error(`unexpected round ${n}`);
    }) as unknown as FakeOpenAI;
    const code = await runOneShot({
      registry,
      model: "test-model",
      base: null,
      prompt: "say hi",
      openai: fake,
      quiet: true,
    });
    const stdout = out.text();
    out.stop();
    assert(code === 0, `exit code: ${code}`);
    assert(stdout.includes("Hello, hi."), `answer in stdout: ${JSON.stringify(stdout)}`);
    assert(stdout.includes("prompt:"), `prompt line still present: ${JSON.stringify(stdout)}`);
    assert(
      !stdout.includes("slask-mcp agent"),
      `banner omitted in quiet mode: ${JSON.stringify(stdout)}`
    );
    assert(
      !stdout.includes("server :"),
      `server line omitted in quiet mode: ${JSON.stringify(stdout)}`
    );
    console.log("PASS test11 — quiet runOneShot omits the startup banner");
  }

  // ---- Test 12: REPL /schedule parse (5 cron fields, rest = prompt) --------
  {
    // null when the first token isn't exactly "/schedule"
    assert(parseScheduleCmd("") === null, "empty -> null");
    assert(parseScheduleCmd("hello world") === null, "non-schedule -> null");
    assert(parseScheduleCmd("/scheduling") === null, "/scheduling -> null");

    // no subcommand / unknown subcommand -> help
    assert(parseScheduleCmd("/schedule")?.kind === "help", "no sub -> help");
    assert(parseScheduleCmd("/schedule help")?.kind === "help", "unknown sub -> help");

    // list
    assert(parseScheduleCmd("/schedule list")?.kind === "list", "list");

    // rm
    const rm = parseScheduleCmd("/schedule rm abc123");
    assert(rm?.kind === "rm", "rm kind");
    assert(rm?.ref === "abc123", `rm ref: ${rm?.ref}`);
    assert(parseScheduleCmd("/schedule rm")?.kind === "error", "rm missing id -> error");

    // add: 5 cron fields + prompt, case preserved
    const add = parseScheduleCmd("/schedule add */5 * * * * say hi there");
    assert(add?.kind === "add", "add kind");
    assert(add?.expr === "*/5 * * * *", `add expr: ${add?.expr}`);
    assert(add?.prompt === "say hi there", `add prompt: ${add?.prompt}`);

    // add: numeric 5-field cron + multi-word prompt
    const add2 = parseScheduleCmd(
      "/schedule add 0 9 * * 1 send a daily report to the team"
    );
    assert(add2?.kind === "add", "add2 kind");
    assert(add2?.expr === "0 9 * * 1", `add2 expr: ${add2?.expr}`);
    assert(add2?.prompt === "send a daily report to the team", "add2 prompt");

    // add: too few cron fields -> error
    assert(
      parseScheduleCmd("/schedule add 5 say hi")?.kind === "error",
      "add too-few fields -> error"
    );
    // add: no prompt -> error
    assert(
      parseScheduleCmd("/schedule add 5 5 5 5 5")?.kind === "error",
      "add no prompt -> error"
    );

    // command/sub case-insensitive; prompt case preserved
    const add3 = parseScheduleCmd("/Schedule ADD */5 * * * * Mixed Case Prompt");
    assert(add3?.kind === "add", "add3 kind (case-insensitive)");
    assert(add3?.prompt === "Mixed Case Prompt", `add3 prompt case: ${add3?.prompt}`);

    console.log("PASS test12 — REPL /schedule parse (5 cron fields, rest = prompt)");
  }

  // ---- Tests 13-18: updateJob (the "change" behind schedule_update) --------
  {
    const file = join(workDir, "updx.json");
    const job = await addJob("1 * * * *", "old prompt", file);
    const updated = await updateJob(job.id, { expr: "15 * * * *" }, file);
    assert(updated.expr === "15 * * * *", `expr updated: ${JSON.stringify(updated.expr)}`);
    assert(updated.prompt === "old prompt", `prompt unchanged: ${JSON.stringify(updated.prompt)}`);
    const loaded = await listJobs(file);
    assert(loaded[0].id === job.id && loaded[0].expr === "15 * * * *", `persisted: ${JSON.stringify(loaded)}`);
    console.log("PASS test13 — updateJob expr only");
  }

  {
    const file = join(workDir, "upprompt.json");
    const job = await addJob("* * * * *", "old prompt", file);
    const updated = await updateJob(job.id, { prompt: "new prompt" }, file);
    assert(updated.expr === "* * * * *", `expr unchanged: ${JSON.stringify(updated.expr)}`);
    assert(updated.prompt === "new prompt", `prompt updated: ${JSON.stringify(updated.prompt)}`);
    const loaded = await listJobs(file);
    assert(loaded[0].prompt === "new prompt", `persisted prompt: ${JSON.stringify(loaded)}`);
    console.log("PASS test14 — updateJob prompt only");
  }

  {
    const file = join(workDir, "upboth.json");
    const job = await addJob("1 * * * *", "old", file);
    const updated = await updateJob(job.id, { expr: "2 * * * *", prompt: "both new" }, file);
    assert(updated.expr === "2 * * * *", `expr: ${JSON.stringify(updated.expr)}`);
    assert(updated.prompt === "both new", `prompt: ${JSON.stringify(updated.prompt)}`);
    const loaded = await listJobs(file);
    assert(loaded[0].expr === "2 * * * *" && loaded[0].prompt === "both new", `persisted: ${JSON.stringify(loaded)}`);
    console.log("PASS test15 — updateJob both expr and prompt");
  }

  {
    const file = join(workDir, "upnone.json");
    const job = await addJob("* * * * *", "x", file);
    let err1 = "";
    try {
      await updateJob(job.id, {}, file);
    } catch (e) {
      err1 = e instanceof Error ? e.message : String(e);
    }
    assert(err1.includes("at least one of"), `neither field error: ${JSON.stringify(err1)}`);
    let err2 = "";
    try {
      await updateJob(job.id, { prompt: "   " }, file);
    } catch (e) {
      err2 = e instanceof Error ? e.message : String(e);
    }
    assert(err2.includes("prompt must not be empty"), `empty prompt error: ${JSON.stringify(err2)}`);
    console.log("PASS test16 — updateJob neither/blank prompt -> throws");
  }

  {
    const file = join(workDir, "upmiss.json");
    const job = await addJob("* * * * *", "x", file);
    let err = "";
    try {
      await updateJob("not-a-real-id", { prompt: "new" }, file);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err.includes("no job with id"), `unknown id error: ${JSON.stringify(err)}`);
    assert(err.includes(job.id), `lists available full id: ${JSON.stringify(err)}`);
    console.log("PASS test17 — updateJob unknown id -> lists available full ids");
  }

  {
    const file = join(workDir, "upinvalid.json");
    const job = await addJob("* * * * *", "x", file);
    let err = "";
    try {
      await updateJob(job.id, { expr: "not-a-cron!!!", prompt: "y" }, file);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err.includes("invalid cron expression"), `bad cron error: ${JSON.stringify(err)}`);
    assert(err.includes("5 fields"), `bad cron mentions 5 fields: ${JSON.stringify(err)}`);
    const after = await listJobs(file);
    assert(after.length === 1 && after[0].expr === "* * * * *", `file unchanged: ${JSON.stringify(after)}`);
    console.log("PASS test18 — updateJob invalid cron -> throws, file unchanged");
  }

  // ---- Tests 19-27: schedule tools (agent-invocable, default file, isolated)
  {
    const toolDir = join(workDir, "tool-dir");
    await mkdir(toolDir, { recursive: true });
    process.chdir(toolDir);
    try {
      {
        const out = await callScheduleTool("schedule_list", {});
        assert(out.isError === false, `list not an error: ${JSON.stringify(out)}`);
        assert(
          textFrom(out.content).includes("no scheduled jobs"),
          `empty list: ${JSON.stringify(textFrom(out.content))}`
        );
        assert(textFrom(out.content).includes("schedule_add"), `mentions schedule_add: ${JSON.stringify(textFrom(out.content))}`);
        console.log("PASS test19 — schedule_list with no jobs -> 'no scheduled jobs'");
      }

      {
        const addOut = await callScheduleTool("schedule_add", { expr: "0 9 * * *", prompt: "check the deploy log" });
        assert(addOut.isError === false, `add not an error: ${JSON.stringify(addOut)}`);
        const jobs = await listJobs();
        assert(jobs.length === 1, `exactly one job after add: ${JSON.stringify(jobs)}`);
        const job = jobs[0];
        assert(textFrom(addOut.content).includes("added job"), `add text: ${textFrom(addOut.content)}`);
        assert(textFrom(addOut.content).includes(job.id), `add text includes full id: ${textFrom(addOut.content)}`);
        assert(job.prompt === "check the deploy log", `prompt persisted: ${JSON.stringify(job.prompt)}`);
        assert(job.expr === "0 9 * * *", `expr persisted: ${JSON.stringify(job.expr)}`);
        console.log("PASS test20 — schedule_add creates a job; text shows the full id");
      }

      {
        const job = (await listJobs())[0];
        const out = await callScheduleTool("schedule_list", {});
        const t = textFrom(out.content);
        assert(t.includes(job.id), `list includes full id: ${t}`);
        assert(t.includes(job.expr), `list includes expr: ${t}`);
        assert(t.includes(job.prompt), `list includes prompt: ${t}`);
        assert(t.includes("1 job(s)"), `lists the count: ${t}`);
        console.log("PASS test21 — schedule_list with a job -> full id + expr + prompt");
      }

      {
        const job = (await listJobs())[0];
        const out = await callScheduleTool("schedule_update", { id: job.id, expr: "0 10 * * *" });
        assert(out.isError === false, `update not an error: ${JSON.stringify(out)}`);
        const afterUp = (await listJobs()).find((j) => j.id === job.id);
        assert(afterUp?.expr === "0 10 * * *", `expr updated: ${JSON.stringify(afterUp?.expr)}`);
        assert(afterUp?.prompt === "check the deploy log", `prompt unchanged: ${JSON.stringify(afterUp?.prompt)}`);
        assert(textFrom(out.content).includes("updated job"), `update text: ${textFrom(out.content)}`);
        assert(textFrom(out.content).includes(job.id), `update text includes full id`);
        console.log("PASS test22 — schedule_update changes expr, leaves prompt");
      }

      {
        const job = (await listJobs())[0];
        const out = await callScheduleTool("schedule_update", { id: job.id, expr: "1 9 * * *", prompt: "   " });
        assert(out.isError === false, `update2 not an error: ${JSON.stringify(out)}`);
        const afterUp2 = (await listJobs()).find((j) => j.id === job.id);
        assert(afterUp2?.prompt === "check the deploy log", `blank prompt ignored: ${JSON.stringify(afterUp2?.prompt)}`);
        assert(afterUp2?.expr === "1 9 * * *", `expr still updated: ${JSON.stringify(afterUp2?.expr)}`);
        console.log("PASS test23 — schedule_update ignores blank expr/prompt fields");
      }

      {
        const job = (await listJobs())[0];
        let err = "";
        try {
          await callScheduleTool("schedule_remove", { id: "not-a-real-id" });
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        assert(err.includes("no job with id"), `remove miss error: ${JSON.stringify(err)}`);
        assert(err.includes(job.id), `remove miss lists available id: ${JSON.stringify(err)}`);
        console.log("PASS test24 — schedule_remove unknown id -> throws, lists available");
      }

      {
        const job = (await listJobs())[0];
        const out = await callScheduleTool("schedule_remove", { id: job.id });
        assert(out.isError === false, `remove not an error: ${JSON.stringify(out)}`);
        assert(textFrom(out.content).includes("removed job"), `remove text: ${textFrom(out.content)}`);
        assert(textFrom(out.content).includes(job.id), `remove text includes full id`);
        assert((await listJobs()).length === 0, `job gone: ${JSON.stringify(await listJobs())}`);
        console.log("PASS test25 — schedule_remove deletes the job");
      }

      {
        let err = "";
        try {
          await callScheduleTool("schedule_add", { prompt: "missing expr" });
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        assert(err.includes("required"), `add missing-error: ${JSON.stringify(err)}`);
        console.log("PASS test26 — schedule_add with no expr/prompt -> throws");
      }

      {
        let err = "";
        try {
          await callScheduleTool("schedule_bop", {});
        } catch (e) {
          err = e instanceof Error ? e.message : String(e);
        }
        assert(err.includes("unknown schedule tool"), `unknown name: ${JSON.stringify(err)}`);
        console.log("PASS test27 — callScheduleTool unknown name -> throws");
      }
    } finally {
      process.chdir(workDir);
    }
  }

  // ---- Tests 28-29: tool definitions & system-prompt block -----------------
  {
    const block = scheduleSystemBlock();
    for (const n of ["schedule_list", "schedule_add", "schedule_update", "schedule_remove"]) {
      assert(block.includes(n), `system block mentions ${n}`);
    }
    console.log("PASS test28 — scheduleSystemBlock advertises all four tools");
  }
  {
    const names = scheduleTools().map((t) => t.function.name);
    assert(names.length === 4, `4 tools: ${JSON.stringify(names)}`);
    for (const n of ["schedule_list", "schedule_add", "schedule_update", "schedule_remove"]) {
      assert(names.includes(n), `scheduleTools includes ${n}: ${JSON.stringify(names)}`);
    }
    console.log("PASS test29 — scheduleTools() returns the four named tool definitions");
  }

  // ---- Test 30: daemon reschedules when a job's expr changes --------------
  {
    const cron = makeFakeCron();
    const file = join(workDir, "resch.json");
    await addJob("1 * * * *", "jobA", file);
    const job = (await listJobs(file))[0];
    const handle = await runScheduler({
      file,
      pollMs: 50,
      scheduleFn: cron.scheduleFn,
      runJobFn: async () => 0,
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.includes("1 * * * *"), 1000);
    await updateJob(job.id, { expr: "2 * * * *" }, file); // change expr while daemon runs
    await waitFor(() => cron.exprs.includes("2 * * * *"), 1000);
    assert(cron.exprs.includes("2 * * * *"), `new expr scheduled: [${cron.exprs.join(", ")}]`);
    assert(!cron.exprs.includes("1 * * * *"), `old expr no longer scheduled: [${cron.exprs.join(", ")}]`);
    assert(cron.stopped.includes("1 * * * *"), `old expr task stop() was called: [${cron.stopped.join(", ")}]`);
    await handle.stop();
    console.log("PASS test30 — daemon reschedules on expr change (old stopped, new scheduled)");
  }

  // ---- Test 31: daemon fires the fresh prompt (re-read at fire time) -----
  {
    const cron = makeFakeCron();
    const file = join(workDir, "fresh.json");
    await addJob("3 * * * *", "old prompt", file);
    const job = (await listJobs(file))[0];
    const rec = { prompt: "" as string };
    const handle = await runScheduler({
      file,
      pollMs: 50,
      scheduleFn: cron.scheduleFn,
      runJobFn: (j) => {
        rec.prompt = j.prompt;
        return Promise.resolve(0);
      },
      log: () => {},
      autoHandlers: false,
    });
    await waitFor(() => cron.exprs.includes("3 * * * *"), 1000);
    await updateJob(job.id, { prompt: "fresh prompt" }, file); // change prompt while daemon runs
    cron.fire("3 * * * *");
    await waitFor(() => rec.prompt === "fresh prompt", 1000);
    assert(rec.prompt === "fresh prompt", `fired with fresh prompt, got "${rec.prompt}"`);
    await handle.stop();
    console.log("PASS test31 — daemon fire uses the fresh prompt (re-read at fire time)");
  }

  console.log("\nALL SCHEDULE TESTS PASSED");
} finally {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
}
process.exit(0);
