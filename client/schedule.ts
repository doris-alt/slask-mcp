// schedule.ts — the client's cron scheduler.
//
//   slask-client schedule                 run the scheduler daemon (Ctrl+C to stop)
//   slask-client schedule add <s> <p>     add a job: <s> is a 5-field cron (recurring)
//                                         or a space-free ISO date/time (one-shot)
//   slask-client schedule list            list scheduled jobs
//   slask-client schedule rm <id>         remove a scheduled job
//
// Jobs are stored in `<cwd>/.slask-schedule.json` (same cwd convention as
// `.env` / `mcp.json`) and each firing spawns *this* CLI as a one-shot child
// (`<same binary> --prompt <job.prompt> --quiet`), so a firing behaves
// exactly like a manual `slask-client --prompt <text>` run from that directory
// (the child inherits the daemon's cwd and environment, and there is no
// shell — prompts are never interpreted as shell input).
//
// Design notes:
//   * The daemon is one process, kept alive by its live tasks (cron for
//     recurring jobs, a single timer for one-shots) + a poll timer.
//     Jobs fire only while this process is running.
//   * Runs are serialized: a FIFO queue with at most one in-flight run, so a
//     slow/hung firing can't starve other jobs or pile up unbounded. Each
//     run has a timeout (default 30 min, env SLASK_SCHEDULE_TIMEOUT_S); on
//     timeout the child is SIGTERMeD then SIGKILLEd, and the run is recorded
//     with status "timeout".
//   * The jobs file is re-read every 15 s (env SLASK_SCHEDULE_POLL_S) and
//     diffed against the live tasks (cron or one-shot timer), so `add`/`rm`/
//     `update` take effect within one poll without restarting the daemon. A
//     one-shot whose time passed while the daemon was down is not fired
//     retroactively — it is logged as missed (update its `at` to reschedule).
//
// Test seams (mirroring the `openai` seam in ui.ts): `scheduleFn` (fake cron
// engine), `runJobFn` (fake child), `log`, `pollMs`, `timeoutS`, and
// `autoHandlers: false` (no SIGINT/SIGTERM listeners installed; the caller
// controls shutdown via the returned handle).

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import cron from "node-cron";
import { dirname, join } from "node:path";
import type { CallToolResult, OpenAiFunctionTool } from "./types.js";

type ChildProcess = ReturnType<typeof spawn>;

// ---------------------------------------------------------------------------
// Job model + storage
// ---------------------------------------------------------------------------

export interface ScheduleJob {
  id: string;
  /** Recurring job: the 5-field cron expression. Set for cron jobs. */
  expr?: string;
  /** One-shot job: the firing time as a normalized UTC ISO-8601 string. Set for one-shot jobs. */
  at?: string;
  prompt: string;
  createdAt: string;
  lastRun?: string;
  lastStatus?: "ok" | "failed" | "timeout";
}

export interface ScheduleSpec {
  prompt: string;
  /** Provide exactly one of `expr` (recurring cron) or `at` (one-shot ISO date/time). */
  expr?: string;
  at?: string;
}

interface ScheduleFile {
  jobs: ScheduleJob[];
}

const SCHEDULE_FILE_NAME = ".slask-schedule.json";

/**
 * The agent-invocable schedule tool names (mirrors `FILE_TOOL_NAMES`). These are
 * always available in the REPL and one-shot runs and route to the handlers in
 * `callScheduleTool`. The model references jobs by their *full* UUID id, so the
 * tool text always prints full ids (unlike the compact REPL display).
 */
export const SCHEDULE_TOOL_NAMES: string[] = [
  "schedule_list",
  "schedule_add",
  "schedule_update",
  "schedule_remove",
];

function defaultFile(): string {
  return join(process.cwd(), SCHEDULE_FILE_NAME);
}

// Returns null when the file is simply missing; re-throws other fs errors.
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return null;
    throw e;
  }
}

// Atomic write: temp file in the same directory, then rename over the target.
async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

// Missing file → empty job list (never errors on the first run). Corrupt
// (malformed) file → a clear, actionable error.
export async function loadJobs(file: string = defaultFile()): Promise<ScheduleJob[]> {
  const raw = await readFileOrNull(file);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON — fix or delete it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !("jobs" in parsed) || !Array.isArray((parsed as ScheduleFile).jobs)) {
    throw new Error(`${file} must be JSON with a "jobs" array — fix or delete it`);
  }
  return (parsed as ScheduleFile).jobs;
}

export async function saveJobs(jobs: ScheduleJob[], file: string = defaultFile()): Promise<void> {
  await atomicWrite(file, JSON.stringify({ jobs }, null, 2) + "\n");
}

// Normalize a user-supplied date/time to a UTC ISO-8601 string; throw on an
// unparsable value. (The daemon compares these against Date.now(), so UTC
// normalization makes them unambiguous regardless of the machine's time zone.)
function normalizeAt(at: string): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid date/time: "${at}" (use ISO-8601, e.g. "2026-10-20T09:30:00Z")`);
  }
  return new Date(ms).toISOString();
}

// Classify a raw schedule string as either a recurring 5-field cron or a
// one-shot date/time. A cron expression is exactly five whitespace-separated
// fields and passes `cron.validate`; a one-shot is a date/time `Date.parse`
// accepts. (A cron field is never a parsable date, so the two are unambiguous.)
// Returns the schedule in normalized form (cron as-is; one-shot as UTC ISO-8601).
export type ClassifiedSchedule =
  | { kind: "cron"; expr: string }
  | { kind: "once"; at: string }
  | { kind: "error"; error: string };
export function classifyScheduleArg(raw: string): ClassifiedSchedule {
  const t = (raw ?? "").trim();
  if (t === "") return { kind: "error", error: "schedule is empty" };
  if (cron.validate(t)) return { kind: "cron", expr: t };
  // One-shot: a space-free ISO date/time. ISO date parts always contain hyphens
  // (YYYY-MM-DD[THH:MM:SS…]), so require at least one hyphen before trusting
  // Date.parse — which is lenient enough to hand back a date for bare cron
  // minute fields like "0", "9", or "*/5" that are *not* dates.
  const ms = t.includes("-") ? Date.parse(t) : NaN;
  if (!Number.isNaN(ms)) return { kind: "once", at: normalizeAt(t) };
  return {
    kind: "error",
    error:
      `unrecognized schedule "${t}" — expected a 5-field cron expression ` +
      '(e.g. "0 9 * * *") or a space-free ISO date/time with hyphens ' +
      '(e.g. "2026-10-20T09:30:00Z")',
  };
}

export async function addJob(
  spec: ScheduleSpec,
  file: string = defaultFile(),
): Promise<ScheduleJob> {
  const expr = (spec.expr ?? "").trim();
  const at = (spec.at ?? "").trim();
  if (expr && at) {
    throw new Error(
      "provide either a cron `expr` (recurring) or an `at` date/time (one-shot), not both",
    );
  }
  if (!expr && !at) {
    throw new Error(
      "provide a cron expression (`expr`) or a date/time (`at`) for the job",
    );
  }
  if (expr) {
    if (!cron.validate(expr)) {
      throw new Error(
        `invalid cron expression: "${expr}" (standard 5 fields: minute hour day-of-month month day-of-week)`,
      );
    }
  } else if (Date.parse(at) <= Date.now()) {
    throw new Error(
      "one-shot time is in the past — choose a future time (or use a cron `expr` for a recurring job)",
    );
  }
  const jobs = await loadJobs(file);
  const job: ScheduleJob = {
    id: randomUUID(),
    prompt: spec.prompt,
    createdAt: new Date().toISOString(),
  };
  if (expr) {
    job.expr = expr;
  } else {
    job.at = normalizeAt(at);
  }
  jobs.push(job);
  await saveJobs(jobs, file);
  return job;
}

export async function removeJob(id: string, file: string = defaultFile()): Promise<void> {
  const jobs = await loadJobs(file);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    throw new Error(`no such job: ${id}`);
  }
  jobs.splice(idx, 1);
  await saveJobs(jobs, file);
}

/** Fields a `schedule_update` call may change. At least one must be present. */
export interface JobUpdate {
  /** New 5-field cron expression (replaces the job's current expr / at). */
  expr?: string;
  /** New one-shot firing time, ISO-8601 (replaces the job's current expr / at). */
  at?: string;
  /** New prompt text (replaces the job's current prompt). */
  prompt?: string;
}

/**
 * Change one or more fields of an existing job — the "change" behind
 * `schedule_update`. At least one of `expr` / `at` / `prompt` must be
 * provided. Exactly one of `expr` / `at` may be given (the job stays either a
 * recurring cron or a one-shot); `expr` is validated as a cron expression and
 * `at` as a date/time (same rules as `addJob`). `prompt` must be non-empty.
 * An unknown id throws with the available full ids so the caller (the model)
 * can self-correct. Returns the updated job.
 */
export async function updateJob(
  id: string,
  update: JobUpdate,
  file: string = defaultFile(),
): Promise<ScheduleJob> {
  const promptGiven = update.prompt !== undefined;
  if (promptGiven && String(update.prompt).trim() === "") {
    throw new Error("prompt must not be empty");
  }
  const hasExpr = update.expr !== undefined && update.expr.trim() !== "";
  const hasAt = update.at !== undefined && update.at.trim() !== "";
  const hasPrompt = promptGiven;
  if (!hasExpr && !hasAt && !hasPrompt) {
    throw new Error(
      "at least one of `expr` (new cron), `at` (new one-shot time), or " +
        "`prompt` (new text) is required",
    );
  }
  if (hasExpr && hasAt) {
    throw new Error(
      "provide either `expr` (recurring cron) or `at` (one-shot time), not both",
    );
  }
  if (hasExpr && !cron.validate(update.expr!)) {
    throw new Error(
      `invalid cron expression: "${update.expr!}" (standard 5 fields: minute hour day-of-month month day-of-week)`,
    );
  }
  if (hasAt && Number.isNaN(Date.parse(update.at!))) {
    throw new Error(
      `invalid date/time: "${update.at!}" (use ISO-8601, e.g. "2026-10-20T09:30:00Z")`,
    );
  }
  const jobs = await loadJobs(file);
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) {
    const avail = jobs.map((j) => j.id).join(", ");
    throw new Error(
      `no job with id ${id} (available: ${avail ? avail : "none"})`,
    );
  }
  const job = jobs[idx];
  if (hasExpr) {
    job.expr = update.expr!.trim();
    job.at = undefined; // switching to a recurring cron
  }
  if (hasAt) {
    job.at = normalizeAt(update.at!);
    job.expr = undefined; // switching to a one-shot
  }
  if (hasPrompt) {
    job.prompt = String(update.prompt).trim();
  }
  await saveJobs(jobs, file);
  return job;
}

export async function listJobs(file: string = defaultFile()): Promise<ScheduleJob[]> {
  return loadJobs(file);
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

// A cron engine, abstracted so tests can inject a fake. The engine calls
// `callback` on every match of `expr`; `stop()` cancels it.
type ScheduleFn = (expr: string, callback: () => void) => {
  stop: () => void | Promise<void>;
};

// A live job task as tracked by the daemon. Recurring jobs run a cron engine;
// one-shot jobs run a single `setTimeout`. Both expose `stop()` so the daemon
// can cancel either.
type LiveTask =
  | { kind: "cron"; expr: string; stop: () => void | Promise<void> }
  | { kind: "once"; atMs: number; stop: () => void | Promise<void> };

// The real engine: node-cron's schedule()/stop() pair.
const defaultScheduleFn: ScheduleFn = (expr, callback) => {
  const task = cron.schedule(expr, () => {
    callback();
  });
  return { stop: () => task.stop() };
};

export interface RunSchedulerOptions {
  /** Jobs file path (default: `<cwd>/.slask-schedule.json`). */
  file?: string;
  /** Re-read the jobs file and sync cron tasks every so often (default 15 s). */
  pollMs?: number;
  /** Per-run timeout in seconds (default 1800 = 30 min). */
  timeoutS?: number;
  /** Fake cron engine (tests). Default: node-cron. */
  scheduleFn?: ScheduleFn;
  /** Fake child runner (tests); resolves with the child exit code.
     Default: spawn this CLI as `--prompt <job.prompt> --quiet` and
     resolve with the child's exit code (-1 = timed out, -2 = spawn error). */
  runJobFn?: (job: ScheduleJob) => Promise<number>;
  /** Output sink (tests). Default: console.log. */
  log?: (line: string) => void;
  /** Install SIGINT/SIGTERM handlers (default true). With false, the caller
     must drive shutdown via the returned handle. */
  autoHandlers?: boolean;
}

export interface SchedulerHandle {
  /** Stop the scheduler: stop cron tasks, wait for the in-flight run (hard-
   * kill after the grace period), then exit cleanly. */
  stop(): Promise<void>;
}

const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_S = 1800;
const SHUTDOWN_GRACE_MS = 10_000; // in-flight run grace before hard kill
const SIGKILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL gap

export async function runScheduler(options: RunSchedulerOptions = {}): Promise<SchedulerHandle> {
  const {
    file = defaultFile(),
    pollMs = options.pollMs ?? DEFAULT_POLL_MS,
    timeoutS = options.timeoutS ?? DEFAULT_TIMEOUT_S,
    log = console.log,
    autoHandlers = options.autoHandlers ?? true,
  } = options;
  const scheduleFn = options.scheduleFn ?? defaultScheduleFn;

  // The default runJobFn spawns this CLI as a one-shot child (argv[1] is the
  // daemon's entry file, so the child is the identical binary + path).
  const childRunJob = (job: ScheduleJob) => runChild(job, timeoutS * 1000);
  const runJobFn: (job: ScheduleJob) => Promise<number> =
    options.runJobFn ?? childRunJob;

  // -- state -----------------------------------------------------------------
  const queue: ScheduleJob[] = [];
  const cronTasks = new Map<string, LiveTask>();
  let busy = false;
  let shuttingDown = false;
  let busyDone: Promise<void> | null = null;
  let busyDoneResolve: (() => void) | null = null;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // -- child lifecycle ---------------------------------------------------------
  let currentChild: ChildProcess | null = null;

  // Spawn this CLI as a one-shot child and resolve with an effective exit
  // code: 0 = ok, -1 = timed out (SIGTERM, then SIGKILL if still alive),
  // -2 = child failed to start, >0 = the child's own non-zero exit code.
  function runChild(job: ScheduleJob, timeoutMs: number): Promise<number> {
    const child = spawn(
      process.execPath,
      [process.argv[1] ?? "", "--prompt", job.prompt, "--quiet"],
      { stdio: "inherit" },
    );
    currentChild = child;
    return new Promise<number>((resolve) => {
      let done = false;
      let killTimer: NodeJS.Timeout | undefined;
      const clearKill = () => {
        if (killTimer !== undefined) {
          clearTimeout(killTimer);
          killTimer = undefined;
        }
      };
      const finish = (code: number) => {
        if (done) return;
        done = true;
        currentChild = null;
        resolve(code);
      };
      // On timeout: SIGTERM, then SIGKILL if the child is still alive.
      const timeoutTimer = setTimeout(() => {
        if (done) return;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          child.kill("SIGKILL");
          finish(-1);
        }, SIGKILL_GRACE_MS);
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timeoutTimer);
        clearKill();
        finish(code === null ? -1 : code);
      });
      child.on("error", () => {
        clearTimeout(timeoutTimer);
        clearKill();
        finish(-2);
      });
    });
  }

  // -- per-run bookkeeping -----------------------------------------------------
  async function recordRun(job: ScheduleJob, status: ScheduleJob["lastStatus"]): Promise<void> {
    const jobs = await loadJobs(file);
    const j = jobs.find((x) => x.id === job.id);
    if (j === undefined) return; // removed while running — nothing to update
    j.lastRun = new Date().toISOString();
    j.lastStatus = status;
    await saveJobs(jobs, file);
  }

  // -- the serial run pump ------------------------------------------------------
  async function pump(): Promise<void> {
    if (busy || shuttingDown) return;
    const job = queue.shift();
    if (job === undefined) return;
    busy = true;
    busyDone = new Promise<void>((r) => {
      busyDoneResolve = r;
    });
    log(`\n--- [${new Date().toISOString()}] job ${job.id.slice(0, 6)} (${job.expr}) ---`);
    try {
      const code = await runJobFn(job);
      const status: ScheduleJob["lastStatus"] =
        code === 0 ? "ok" : code === -1 ? "timeout" : "failed";
      await recordRun(job, status);
      log(
        `--- job ${job.id.slice(0, 6)} exit ${code === 0 ? "0 (ok)" : code === -1 ? "timeout" : String(code)}` +
          ` ---`,
      );
    } catch (e) {
      log(
        `--- job ${job.id.slice(0, 6)} error: ${
          e instanceof Error ? e.message : String(e)
        } ---`,
      );
      await recordRun(job, "failed").catch(() => {
        // job may have been removed in the meantime
      });
    } finally {
      busy = false;
      busyDoneResolve?.();
      busyDone = null;
      void pump();
    }
  }

  // Fire by id: re-read the current job from the file so the prompt (and expr)
  // are always up-to-date, even if the job was `schedule_update`d since the cron
  // task was scheduled. Returns early if the job was removed in the meantime.
  async function fireJobById(id: string): Promise<void> {
    const jobs = await loadJobs(file);
    const job = jobs.find((j) => j.id === id);
    if (job === undefined) return;
    queue.push(job);
    void pump();
  }

  // -- live sync (poll the file, diff against the live cron tasks) -------------
  async function sync(): Promise<void> {
    if (shuttingDown) return;
    let jobs: ScheduleJob[];
    try {
      jobs = await loadJobs(file);
    } catch (e) {
      log(
        `scheduler: could not load jobs file (${file}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      return;
    }
    const liveIds = new Set(jobs.map((j) => j.id));
    // stop tasks whose job was removed from the file
    for (const id of [...cronTasks.keys()]) {
      if (liveIds.has(id)) continue;
      const task = cronTasks.get(id);
      cronTasks.delete(id);
      if (task === undefined) continue;
      try {
        await task.stop();
      } catch {
        // ignore
      }
      log(`scheduler: stopped job ${id.slice(0, 6)} (no longer in ${file})`);
    }
    // sync each live job:
    //   * recurring (expr): keep the cron task unless it is new or its expr changed
    //     (an expr change means the running cron is on the old schedule, so reschedule);
    //   * one-shot (at): arm a single timer if the time is in the future and the job
    //     has not fired yet; skip a job whose time passed while the daemon was down
    //     (logged as "missed") and any already-fired job.
    for (const job of jobs) {
      const existing = cronTasks.get(job.id);
      // Cancel any stale task for this job before (re)creating it.
      const stopExisting = async (): Promise<void> => {
        if (existing === undefined) return;
        cronTasks.delete(job.id);
        try {
          await existing.stop();
        } catch {
          // ignore
        }
      };

      if (job.expr !== undefined) {
        const sameCron = existing !== undefined && existing.kind === "cron" && existing.expr === job.expr;
        if (sameCron) continue; // task already on the correct schedule
        await stopExisting();
        try {
          const task = scheduleFn(job.expr, () => void fireJobById(job.id));
          cronTasks.set(job.id, { kind: "cron", expr: job.expr, stop: () => task.stop() });
          log(
            `scheduler: ${existing !== undefined ? "rescheduled" : "started"} job ` +
              `${job.id.slice(0, 6)} — ${job.expr}`,
          );
        } catch (e) {
          log(
            `scheduler: skipping job ${job.id.slice(0, 6)} (${job.expr}): ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      } else if (job.at !== undefined) {
        const atMs = Date.parse(job.at);
        if (job.lastRun !== undefined) {
          // already fired — make sure no stale timer remains; do not reschedule.
          await stopExisting();
          continue;
        }
        if (atMs <= Date.now()) {
          // the daemon was down when the time came; never fire a missed one-shot.
          await stopExisting();
          log(
            `scheduler: one-shot job ${job.id.slice(0, 6)} (${job.at}) is in the past ` +
              "and has not run — skipping (missed); update its `at` to reschedule",
          );
          continue;
        }
        await stopExisting();
        const timer = setTimeout(() => { void fireJobById(job.id); }, atMs - Date.now());
        cronTasks.set(job.id, { kind: "once", atMs, stop: () => clearTimeout(timer) });
        log(`scheduler: scheduled one-shot job ${job.id.slice(0, 6)} @ ${job.at}`);
      }
    }
  }

  // -- shutdown -----------------------------------------------------------------
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log("scheduler: stopping…");
    if (pollTimer) clearInterval(pollTimer);
    for (const task of cronTasks.values()) {
      try {
        await task.stop();
      } catch {
        // ignore
      }
    }
    cronTasks.clear();
    if (busy) {
      const deadline = Date.now() + SHUTDOWN_GRACE_MS;
      log(
        `scheduler: one run in flight — giving it up to ${SHUTDOWN_GRACE_MS / 1000} s…`,
      );
      const killCheck = setInterval(() => {
        if (busy && Date.now() >= deadline && currentChild) {
          currentChild.kill("SIGKILL");
        }
      }, 250);
      try {
        await busyDone ?? Promise.resolve();
      } finally {
        clearInterval(killCheck);
      }
    }
    log("scheduler: stopped");
  }

  // -- startup ------------------------------------------------------------------
  const initial = await loadJobs(file);
  if (initial.length === 0) {
    log("scheduler: started with 0 jobs (add one with: slask-client schedule add <schedule> <prompt> — a 5-field cron or an ISO date/time for a one-shot)");
  } else {
    log(`scheduler: started with ${initial.length} job(s) from ${file} (live-sync every ${pollMs} ms)`);
  }
  log("scheduler: Ctrl+C to stop");
  void sync(); // schedules the initial jobs; re-runs on every poll
  pollTimer = setInterval(() => {
    void sync();
  }, pollMs);

  if (autoHandlers) {
    const handler = () => {
      void shutdown().finally(() => {
        process.exitCode = 0;
        process.exit(0);
      });
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
  }

  return { stop: shutdown };
}

// ---------------------------------------------------------------------------
// schedule tools (agent-invocable): list / add / update / remove
//
// Mirrors the file/skill local-tool pattern: `scheduleTools()` yields the
// `OpenAiFunctionTool[]` merged into `runTurn`'s tool array; `callScheduleTool`
// routes a named call to its handler and returns an MCP `CallToolResult`;
// `scheduleSystemBlock()` is appended to the agent's system prompt. The model
// references jobs by their *full* UUID id.
// ---------------------------------------------------------------------------

/** One line per job in `schedule_list`'s output. Full id (unambiguous). */
function scheduleListText(jobs: ScheduleJob[]): string {
  if (jobs.length === 0) {
    return (
      "no scheduled jobs yet. Use `schedule_add` with a 5-field cron `expr` " +
      "(recurring) or an ISO date/time `at` (one-shot), plus a `prompt`."
    );
  }
  const lines = jobs.map((j) => {
    const when =
      j.expr
        ? `cron "${j.expr}"`
        : j.at
        ? `once @ ${j.at}`
        : "no schedule";
    const last = j.lastRun
      ? `last: ${j.lastRun.slice(0, 16)} (${j.lastStatus})`
      : "last: none yet";
    return `  - id=${j.id}\n    ${when} prompt="${j.prompt}" ${last}`;
  });
  return `${jobs.length} job(s):\n${lines.join("\n")}`;
}

/** The OpenAI function-calling definitions for the schedule tools. */
export function scheduleTools(): OpenAiFunctionTool[] {
  const cron =
    "a standard 5-field cron expression: minute hour day-of-month month day-of-week " +
    "(e.g. `0 9 * * *` = daily at 9:00, `*/5 * * * *` = every 5 minutes)";
  return [
    {
      type: "function",
      function: {
        name: "schedule_list",
        description:
          "List all scheduled jobs with their full UUID id, cron expression, prompt, " +
          "and last-run/status. Returns 'no scheduled jobs yet' when there are none. " +
          "Use when the user asks what is scheduled. The full id shown here is needed " +
          "by `schedule_update` and `schedule_remove`.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_add",
        description:
          "Create a new scheduled job. Either provide a 5-field cron `expr` (the " +
          "prompt runs on every match) or an ISO date/time `at` (the prompt runs " +
          "exactly once, at that time). In both cases the run behaves like a manual " +
          "`slask-client --prompt` one-shot run. Provide exactly one of `expr`/`at`. " +
          "Use when the user asks to set up a recurring task/reminder, or a one-time " +
          "remind-me-at-a-specific-time. Returns the new job's full id.",
        parameters: {
          type: "object",
          properties: {
            expr: { type: "string", description: cron },
            at: {
              type: "string",
              description:
                "one-shot firing time in ISO-8601, e.g. \"2026-10-20T09:30:00Z\" " +
                "(space-free)",
            },
            prompt: { type: "string", description: "the prompt text to run on each firing" },
          },
          required: ["prompt"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_update",
        description:
          "Change an existing scheduled job by its full UUID id (as shown by " +
          "`schedule_list`). Provide the new schedule — a 5-field cron `expr` " +
          "(recurring) or an ISO date/time `at` (one-shot) — and/or the new `prompt`; " +
          "at least one is required. `expr` and `at` are mutually exclusive. Returns " +
          "the updated job.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "the full job UUID id from `schedule_list`" },
            expr: { type: "string", description: "new 5-field cron expression" },
            at: {
              type: "string",
              description:
                "one-shot firing time in ISO-8601, e.g. \"2026-10-20T09:30:00Z\" " +
                "(space-free)",
            },
            prompt: { type: "string", description: "new prompt text" },
          },
          required: ["id"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "schedule_remove",
        description:
          "Delete a scheduled job by its full UUID id (as shown by `schedule_list`). " +
          "Returns a confirmation.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "the full job UUID id to remove" },
          },
          required: ["id"],
        },
      },
    },
  ];
}

/**
 * Router used by the agent loop: dispatches a named schedule tool to its handler
 * and wraps the outcome in MCP's `CallToolResult` shape. Unknown names, invalid cron
 * expressions, empty/unknown ids, and fs errors throw — `runAgentTurn` feeds any
 * throw back to the model as `ERROR calling <name>: <message>`, so a bad cron or
 * unknown id is a recoverable step, not a crash.
 */
export async function callScheduleTool(
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  switch (name) {
    case "schedule_list": {
      const text = scheduleListText(await listJobs());
      return { isError: false, content: [{ type: "text", text }] };
    }
    case "schedule_add": {
      const expr = String(args.expr ?? "").trim();
      const at = String(args.at ?? "").trim();
      const prompt = String(args.prompt ?? "").trim();
      if (prompt === "") {
        throw new Error("`prompt` is required");
      }
      // addJob trims + validates: rejects both/neither of expr|at, validates the
      // cron when expr is given, and rejects an `at` already in the past.
      const job = await addJob({
        prompt,
        expr: expr || undefined,
        at: at || undefined,
      });
      const when = job.expr ? `expr="${job.expr}"` : `at="${job.at}"`;
      const detail = job.expr
        ? "fires on each match of the cron expression while the `slask-client schedule` daemon is running"
        : "runs exactly once, at its scheduled time (if the `slask-client schedule` daemon is running for that moment)";
      const text = `added job ${job.id} — ${when}: ${job.prompt}. ${detail}`;
      return { isError: false, content: [{ type: "text", text }] };
    }
    case "schedule_update": {
      const id = String(args.id ?? "").trim();
      if (id === "") {
        throw new Error("`id` is required (see `schedule_list`)");
      }
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() !== ""
          ? v.trim()
          : undefined;
      const job = await updateJob(id, {
        expr: str(args.expr),
        at: str(args.at),
        prompt: str(args.prompt),
      });
      const when = job.expr ? `expr="${job.expr}"` : `at="${job.at}"`;
      const text = `updated job ${job.id} — ${when}: ${job.prompt}`;
      return { isError: false, content: [{ type: "text", text }] };
    }
    case "schedule_remove": {
      const id = String(args.id ?? "").trim();
      if (id === "") {
        throw new Error("`id` is required (see `schedule_list`)");
      }
      const jobs = await listJobs();
      const match = jobs.find((j) => j.id === id);
      if (match === undefined) {
        const avail = jobs.map((j) => j.id).join(", ");
        throw new Error(`no job with id ${id} (available: ${avail ? avail : "none"})`);
      }
      await removeJob(match.id);
      const when = match.expr ? `expr="${match.expr}"` : `at="${match.at}"`;
      const text = `removed job ${match.id} (${when})`;
      return { isError: false, content: [{ type: "text", text }] };
    }
    default:
      throw new Error("unknown schedule tool " + JSON.stringify(name));
  }
}

/** The system-prompt paragraph advertising the schedule tools (always available). */
export function scheduleSystemBlock(): string {
  return (
    "\n\nSchedule management: you have built-in schedule tools — `schedule_list` " +
    "(list jobs, with each job's full UUID id), `schedule_add` (create a job), " +
    "`schedule_update` (change a job by its full id), and `schedule_remove` " +
    "(delete a job by id). A job is either *recurring* (provide a 5-field cron " +
    "`expr` — the prompt fires on every match) or *one-shot* (provide an ISO " +
    "date/time `at` — e.g. \"2026-10-20T09:30:00Z\" — and the prompt fires exactly " +
    "once, at that time). Exactly one of `expr`/`at` is required on `schedule_add`; " +
    "`schedule_update` may change the expr, at, or prompt of an existing job (at " +
    "least one; expr and at are mutually exclusive). Each firing runs the prompt " +
    "through the agent exactly like a manual `slask-client --prompt` one-shot run. " +
    "Jobs only fire while the `slask-client schedule` daemon is running; changes to " +
    "a job take effect within ~15 s without a restart. When the user asks for a " +
    "recurring reminder/task, convert the requested time into a standard 5-field cron " +
    "expression (e.g. '9am daily' -> `0 9 * * *`); when they ask for a single run at a " +
    "specific date/time, use `at`."
  );
}