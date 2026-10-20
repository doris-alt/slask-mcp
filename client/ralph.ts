// ralph.ts — the built-in "Ralph" loop (coding + research).
//
//   slask-client ralph init <name> [--mode code|research] [--check <cmd>] [--from prd.json]
//   slask-client ralph add <name> <title> [--criteria "a;b;c"]
//   slask-client ralph run <name> [--max N]     run the loop in the foreground
//   slask-client ralph start <name>             run the loop in a detached process
//   slask-client ralph stop <name> | status [name] | list
//
// Ralph = repeat a *fresh-context* agent run against a task list until every
// task passes. Memory lives only in files: `prd.json` (tasks, `passes` flag),
// `progress.txt` (append-only learnings), and — for code — git history.
//
// State: `<cwd>/.slask-ralph/<run>/` { prd.json, config.json, progress.txt,
// status.json, run.pid, iterations/NN.log, findings/<task>.md, report.md }.
//
// Each iteration spawns this CLI as a child (child.ts, same machinery as the
// scheduler) with SLASK_RALPH_* env vars that switch on the run-only tools
// (`ralph_complete_task`, `ralph_note`, `run_command`, `ralph_verdict`).
// Completion is never taken from the model's text: the worker *claims* a task
// with `ralph_complete_task`, then the loop verifies it with a pluggable
// verifier —
//   code:     the configured check command (e.g. `npm run build && npm test`);
//             on green the loop commits `feat: [T1] - title`.
//   research: a separate fresh-context checker pass judges the task's
//             acceptance criteria against the findings file (`ralph_verdict`).
// A task that fails `maxFailures` times in a row stops the run ("stuck").
//
// Test seams: `runAgentFn` (fake child), `execFn` (fake shell), `log`,
// `autoHandlers: false`.

import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runCliChild } from "./child.js";
import type { ChildProcess } from "./child.js";
import type { CallToolResult, OpenAiFunctionTool } from "./types.js";

// ---------------------------------------------------------------------------
// model + storage
// ---------------------------------------------------------------------------

export type RalphMode = "code" | "research";

export interface RalphTask {
  id: string;
  title: string;
  description?: string;
  acceptanceCriteria: string[];
  priority: number;
  passes: boolean;
  /** Worker called ralph_complete_task; awaiting the verifier. */
  claimed?: boolean;
  /** Consecutive failed verifications. */
  failures?: number;
  lastFailure?: string;
  notes?: string;
}

export interface RalphPrd {
  name: string;
  mode: RalphMode;
  description: string;
  branchName?: string;
  tasks: RalphTask[];
}

export interface RalphConfig {
  mode: RalphMode;
  /** Code verifier: shell command that must exit 0 (e.g. "npm run build && npm test"). */
  check?: string;
  /** Code mode: commit after each verified task. */
  commit: boolean;
  maxIterations: number;
  /** Per-iteration child timeout. */
  timeoutS: number;
  /** Stop the run when one task fails verification this many times in a row. */
  maxFailures: number;
  /** First tokens `run_command` may execute inside the run. */
  allow: string[];
  /** Visible deliverables folder (research findings + report), relative to the
   * workspace. Absent on runs created before this field: they used the hidden
   * run dir. */
  outputDir?: string;
  /** The model's context window in tokens (default 32000). Sizes tool-output caps
   * and history pruning for iterations, and tells planners how small tasks must be. */
  contextTokens?: number;
  /** Max tool calls per iteration (default 25). Exceeding it ends the iteration. */
  toolBudget?: number;
}

export type RalphState = "running" | "done" | "stuck" | "max-iterations" | "stopped";

export interface RalphStatus {
  state: RalphState;
  iteration: number;
  updatedAt: string;
  message?: string;
}

export const STATE_DIR = ".slask-ralph";
export const DEFAULT_CONTEXT_TOKENS = 32000;
export const DEFAULT_TOOL_BUDGET = 25;
export const MAX_SPLIT_DEPTH = 2; // T2 -> T2.1 -> T2.1.1, no further

/** Per-iteration limits derived from a run's config (defaults for old configs). */
export function limitsOf(cfg: Partial<RalphConfig>): {
  contextTokens: number;
  toolBudget: number;
  contextChars: number;
  resultChars: number;
  maxTokens: number;
} {
  const contextTokens = cfg.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const toolBudget = cfg.toolBudget ?? DEFAULT_TOOL_BUDGET;
  const contextChars = Math.floor(contextTokens * 2.5); // conservative chars/token (HTML/JSON-heavy output)
  return {
    contextTokens,
    toolBudget,
    contextChars,
    resultChars: Math.max(2000, Math.floor(contextChars / 10)),
    maxTokens: Math.min(4096, Math.max(512, Math.floor(contextTokens / 4))),
  };
}
export const DEFAULT_ALLOW = [
  "git", "npm", "pnpm", "npx", "node", "tsc", "cargo", "python3", "make", "ls", "cat",
];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function validateName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid run name ${JSON.stringify(name)} (letters, digits, . _ - ; max 64; must start alphanumeric)`,
    );
  }
  return name;
}

/** Where a run's findings/report live: config.outputDir, else the legacy hidden run dir. */
export function outputDirOf(name: string, cfg: Pick<RalphConfig, "outputDir">): string {
  return cfg.outputDir ?? join(STATE_DIR, name);
}

/** Workspace-relative, no `..`, and not inside the internal state dir. */
export function validateOutputDir(dir: string): string {
  const d = dir.trim().replace(/\/+$/, "");
  if (d === "" || d.startsWith("/") || /^[A-Za-z]:/.test(d)) {
    throw new Error(`output dir must be a non-empty path relative to the workspace, got ${JSON.stringify(dir)}`);
  }
  const parts = d.split(/[\\/]+/);
  if (parts.includes("..")) throw new Error(`output dir must not contain "..": ${dir}`);
  if (parts[0] === STATE_DIR) {
    throw new Error(`output dir must not be inside ${STATE_DIR}/ (that is internal loop state)`);
  }
  return d;
}

export function runDir(base: string, name: string): string {
  return join(base, STATE_DIR, validateName(name));
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

export async function loadPrd(base: string, name: string): Promise<RalphPrd> {
  try {
    return await readJson<RalphPrd>(join(runDir(base, name), "prd.json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`no ralph run named "${name}" (see \`ralph list\`)`);
    }
    throw e;
  }
}

export async function savePrd(base: string, prd: RalphPrd): Promise<void> {
  await atomicWrite(join(runDir(base, prd.name), "prd.json"), JSON.stringify(prd, null, 2) + "\n");
}

export async function loadConfig(base: string, name: string): Promise<RalphConfig> {
  return readJson<RalphConfig>(join(runDir(base, name), "config.json"));
}

export async function saveConfig(base: string, name: string, cfg: RalphConfig): Promise<void> {
  await atomicWrite(join(runDir(base, name), "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

// -- project description ("spec") ---------------------------------------------

export const SPEC_FILE = "spec.md";
export const MAX_SPEC_BYTES = 2 * 1024 * 1024;

/** Read a project description file (path relative to the workspace). */
export async function readSpecSource(base: string, file: string): Promise<string> {
  const p = resolve(base, file);
  let st;
  try {
    st = await stat(p);
  } catch {
    throw new Error(`spec file not found: ${file}`);
  }
  if (!st.isFile()) throw new Error(`spec path is not a file: ${file}`);
  if (st.size > MAX_SPEC_BYTES) {
    throw new Error(`spec file is ${Math.round(st.size / 1024)} KB (max ${MAX_SPEC_BYTES / 1024} KB) — split it and keep the overview in the spec`);
  }
  const text = await readFile(p, "utf8");
  if (text.trim() === "") throw new Error(`spec file is empty: ${file}`);
  return text;
}

/** First `# ` heading, else the first non-empty line (trimmed to 200 chars). */
export function deriveDescription(spec: string): string {
  const lines = spec.split(/\r?\n/).map((l) => l.trim());
  const h = lines.find((l) => /^#\s+\S/.test(l));
  const first = h ? h.replace(/^#+\s*/, "") : lines.find((l) => l !== "") ?? "";
  return first.length > 200 ? first.slice(0, 197) + "..." : first;
}

async function specSize(base: string, name: string): Promise<number | null> {
  try {
    return (await stat(join(runDir(base, name), SPEC_FILE))).size;
  } catch {
    return null;
  }
}

/** Replace (or add) a run's spec copy; fills an empty description from it. */
export async function setSpec(base: string, name: string, spec: string): Promise<void> {
  const prd = await loadPrd(base, name);
  await atomicWrite(join(runDir(base, name), SPEC_FILE), spec);
  if (!prd.description) {
    prd.description = deriveDescription(spec);
    await savePrd(base, prd);
  }
}

export interface ConfigureInput {
  check?: string;
  description?: string;
  branchName?: string;
  maxIterations?: number;
  contextTokens?: number;
  toolBudget?: number;
}

/** Update a run's verifier/goal/branch/iteration cap (use while the run is stopped). */
export async function configureRun(base: string, name: string, c: ConfigureInput): Promise<string[]> {
  const prd = await loadPrd(base, name);
  const cfg = await loadConfig(base, name);
  const changed: string[] = [];
  if (c.check !== undefined && c.check.trim() !== "") {
    cfg.check = c.check.trim();
    changed.push("check");
  }
  if (c.description !== undefined && c.description.trim() !== "") {
    prd.description = c.description.trim();
    changed.push("description");
  }
  if (c.branchName !== undefined && c.branchName.trim() !== "") {
    prd.branchName = c.branchName.trim();
    changed.push("branchName");
  }
  if (c.maxIterations !== undefined) {
    if (!Number.isInteger(c.maxIterations) || c.maxIterations < 1) throw new Error("maxIterations must be a positive integer");
    cfg.maxIterations = c.maxIterations;
    changed.push("maxIterations");
  }
  for (const [k, v, min] of [["contextTokens", c.contextTokens, 2000], ["toolBudget", c.toolBudget, 3]] as const) {
    if (v === undefined) continue;
    if (!Number.isInteger(v) || v < min) throw new Error(`${k} must be an integer >= ${min}`);
    cfg[k] = v;
    changed.push(k);
  }
  if (changed.length === 0) throw new Error("nothing to change: give check, description, branchName, maxIterations, contextTokens and/or toolBudget");
  await saveConfig(base, name, cfg);
  await savePrd(base, prd);
  return changed;
}

export async function appendProgress(base: string, name: string, text: string): Promise<void> {
  await appendFile(join(runDir(base, name), "progress.txt"), text.endsWith("\n") ? text : text + "\n");
}

async function readStatus(base: string, name: string): Promise<RalphStatus | null> {
  try {
    return await readJson<RalphStatus>(join(runDir(base, name), "status.json"));
  } catch {
    return null;
  }
}

async function writeStatus(base: string, name: string, s: Omit<RalphStatus, "updatedAt">): Promise<void> {
  const full: RalphStatus = { ...s, updatedAt: new Date().toISOString() };
  await atomicWrite(join(runDir(base, name), "status.json"), JSON.stringify(full, null, 2) + "\n");
}

export interface NewTask {
  id?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: number;
  passes?: boolean;
}

function toTask(t: NewTask, index: number): RalphTask {
  const title = String(t.title ?? "").trim();
  if (title === "") throw new Error(`task ${index + 1} has no title`);
  return {
    id: t.id?.trim() || `T${index + 1}`,
    title,
    description: t.description?.trim() || undefined,
    acceptanceCriteria: (t.acceptanceCriteria ?? []).map((c) => String(c).trim()).filter(Boolean),
    priority: typeof t.priority === "number" ? t.priority : index + 1,
    passes: t.passes === true,
  };
}

/** Accepts our `tasks` array or snarktank/ralph's `userStories` (same fields). */
export function normalizeTasks(raw: unknown): RalphTask[] {
  const obj = (raw ?? {}) as { tasks?: NewTask[]; userStories?: NewTask[] };
  const list = Array.isArray(raw) ? (raw as NewTask[]) : obj.tasks ?? obj.userStories ?? [];
  const tasks = list.map(toTask);
  const ids = new Set<string>();
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id ${t.id}`);
    ids.add(t.id);
  }
  return tasks;
}

export interface CreateRunInput {
  name: string;
  mode?: RalphMode;
  description?: string;
  check?: string;
  commit?: boolean;
  branchName?: string;
  maxIterations?: number;
  timeoutS?: number;
  maxFailures?: number;
  allow?: string[];
  /** Visible deliverables folder (default `ralph-<name>`). */
  outputDir?: string;
  contextTokens?: number;
  toolBudget?: number;
  /** Project description text; stored as spec.md in the run dir. */
  spec?: string;
  tasks?: NewTask[];
}

export async function createRun(base: string, input: CreateRunInput): Promise<RalphPrd> {
  const name = validateName(input.name);
  const mode: RalphMode = input.mode ?? "code";
  if (mode !== "code" && mode !== "research") throw new Error(`mode must be "code" or "research"`);
  const dir = runDir(base, name);
  try {
    await readFile(join(dir, "prd.json"));
    throw new Error(`ralph run "${name}" already exists`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const prd: RalphPrd = {
    name,
    mode,
    description: input.description?.trim() || (input.spec ? deriveDescription(input.spec) : ""),
    branchName: input.branchName?.trim() || undefined,
    tasks: normalizeTasks(input.tasks ?? []),
  };
  const config: RalphConfig = {
    mode,
    check: input.check?.trim() || undefined,
    commit: input.commit ?? mode === "code",
    maxIterations: input.maxIterations ?? 10,
    timeoutS: input.timeoutS ?? 1800,
    maxFailures: input.maxFailures ?? 3,
    allow: input.allow ?? DEFAULT_ALLOW,
    outputDir: validateOutputDir(input.outputDir ?? `ralph-${name}`),
    contextTokens: input.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
    toolBudget: input.toolBudget ?? DEFAULT_TOOL_BUDGET,
  };
  for (const [k, v, min] of [["contextTokens", config.contextTokens, 2000], ["toolBudget", config.toolBudget, 3]] as const) {
    if (v === undefined || !Number.isInteger(v) || v < min) throw new Error(`${k} must be an integer >= ${min}`);
  }
  await mkdir(join(dir, "iterations"), { recursive: true });
  await atomicWrite(join(dir, "config.json"), JSON.stringify(config, null, 2) + "\n");
  await savePrd(base, prd);
  if (input.spec !== undefined) await atomicWrite(join(dir, SPEC_FILE), input.spec);
  await writeFile(
    join(dir, "progress.txt"),
    `# Ralph Progress Log — ${name}\nStarted: ${new Date().toISOString()}\n\n` +
      "## Codebase Patterns\n(reusable patterns/gotchas discovered; keep this section at the top)\n\n---\n",
  );
  return prd;
}

export async function addTask(base: string, name: string, t: NewTask): Promise<RalphTask> {
  const prd = await loadPrd(base, name);
  const nums = prd.tasks.map((x) => /^T(\d+)$/.exec(x.id)?.[1]).filter(Boolean).map(Number);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  const maxPrio = prd.tasks.length ? Math.max(...prd.tasks.map((x) => x.priority)) : 0;
  const task = toTask({ ...t, id: t.id ?? `T${next}`, priority: t.priority ?? maxPrio + 1 }, next - 1);
  if (prd.tasks.some((x) => x.id === task.id)) throw new Error(`task id ${task.id} already exists`);
  prd.tasks.push(task);
  await savePrd(base, prd);
  return task;
}

export function pickNext(prd: RalphPrd): RalphTask | undefined {
  return prd.tasks
    .filter((t) => !t.passes)
    .sort((a, b) => a.priority - b.priority)[0];
}

export async function listRuns(base: string): Promise<string[]> {
  try {
    const names = await readdir(join(base, STATE_DIR));
    const out: string[] = [];
    for (const n of names.sort()) {
      try {
        await readFile(join(base, STATE_DIR, n, "prd.json"));
        out.push(n);
      } catch {
        /* not a run dir */
      }
    }
    return out;
  } catch {
    return [];
  }
}

// -- task granularity ---------------------------------------------------------

interface TaskLike {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
}

/**
 * Problems that make a task too coarse for ONE small-context iteration
 * (empty = fine). Heuristics, applied to model-authored tasks.
 */
export function lintTask(mode: RalphMode, t: TaskLike): string[] {
  const probs: string[] = [];
  const crit = (t.acceptanceCriteria ?? []).map((c) => String(c).trim()).filter(Boolean);
  const desc = t.description ?? "";
  if (crit.length < 2) probs.push("needs at least 2 concrete acceptance criteria");
  if (crit.length > 4) probs.push(`has ${crit.length} acceptance criteria (max 4) — split the task`);
  if (desc.length > 600) probs.push(`description is ${desc.length} chars (max 600) — it covers too much; split the task`);
  const text = [t.title ?? "", desc, ...crit].join("\n");
  if (mode === "research") {
    const files = new Set((text.match(/[\w.\-/]+\.(?:md|txt|csv|json)\b/gi) ?? []).map((f) => f.toLowerCase()));
    if (files.size > 1) probs.push(`names ${files.size} output files (${[...files].join(", ")}) — one task = one output file`);
  }
  const nums = [...text.matchAll(/\b(?:at least|minimum(?: of)?|min\.?|≥|>=)\s*(\d+)\b|\b(\d+)\s*\+|\b(\d+)\s+(?:distinct|different|separate|independent)\b/gi)]
    .map((m) => Number(m[1] ?? m[2] ?? m[3]))
    .filter((n) => n >= 4);
  if (nums.length) probs.push(`asks for ${Math.max(...nums)}+ items — at most 3 per task; split by item/topic/source`);
  return probs;
}

/** Throw (so the planning model sees it and retries) when any task is too coarse. */
export function assertGranular(mode: RalphMode, tasks: TaskLike[], cfg: Partial<RalphConfig> = {}): void {
  const lines = tasks.flatMap((t, i) => lintTask(mode, t).map((p) => `- task ${i + 1} "${t.title ?? ""}": ${p}`));
  if (lines.length === 0) return;
  const lim = limitsOf(cfg);
  throw new Error(
    `too coarse for one iteration (each gets ~${lim.contextTokens} tokens of context and ${lim.toolBudget} tool calls):\n` +
      lines.join("\n") +
      "\nSplit these into smaller tasks (one deliverable, 2-4 criteria, at most ~3 sources/files each) and call again.",
  );
}

/** Replace task `id` with 2-6 smaller tasks (T2 -> T2.1, T2.2, ...); returns the new ids. */
export async function splitTask(base: string, name: string, id: string, subs: NewTask[]): Promise<string[]> {
  const prd = await loadPrd(base, name);
  const i = prd.tasks.findIndex((t) => t.id === id);
  if (i < 0) throw new Error(`no task ${id} in run "${name}"`);
  const depth = id.split(".").length - 1;
  if (depth >= MAX_SPLIT_DEPTH) throw new Error(`${id} was already split ${depth} times — it cannot be split further`);
  if (subs.length < 2 || subs.length > 6) throw new Error("split into 2 to 6 smaller tasks");
  assertGranular(prd.mode, subs, await loadConfig(base, name).catch(() => ({})));
  const orig = prd.tasks[i];
  const made = subs.map((s, k) => toTask({ ...s, id: `${id}.${k + 1}`, priority: orig.priority + (k + 1) / 100 }, k));
  prd.tasks.splice(i, 1, ...made);
  await savePrd(base, prd);
  await appendProgress(base, name, `\n## ${new Date().toISOString()} — ${id} ${orig.title}: SPLIT into ${made.map((m) => `${m.id} ${m.title}`).join("; ")}`);
  return made.map((m) => m.id);
}

// -- pid file / detached runs ------------------------------------------------

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPid(base: string, name: string): Promise<number | null> {
  try {
    const n = Number.parseInt(await readFile(join(runDir(base, name), "run.pid"), "utf8"), 10);
    return Number.isFinite(n) && isAlive(n) ? n : null;
  } catch {
    return null;
  }
}

let forwardArgs: string[] = [];
/** Flags (--model/--base-url/--config/…) that detached runs and their children inherit. */
export function setRalphForwardArgs(args: string[]): void {
  forwardArgs = args;
}

export async function startDetached(base: string, name: string): Promise<number> {
  const dir = runDir(base, name);
  await loadPrd(base, name);
  if ((await readPid(base, name)) !== null) throw new Error(`ralph run "${name}" is already running`);
  const fd = openSync(join(dir, "run.log"), "a");
  try {
    const child = spawn(process.execPath, [process.argv[1] ?? "", "ralph", "run", name, ...forwardArgs], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: base,
    });
    child.unref();
    return child.pid ?? -1;
  } finally {
    closeSync(fd);
  }
}

export async function stopRun(base: string, name: string): Promise<boolean> {
  const pid = await readPid(base, name);
  if (pid === null) return false;
  process.kill(pid, "SIGTERM");
  return true;
}

export async function formatStatus(base: string, name: string): Promise<string> {
  const prd = await loadPrd(base, name);
  const cfg = await loadConfig(base, name).catch(() => null);
  const st = await readStatus(base, name);
  const pid = await readPid(base, name);
  const done = prd.tasks.filter((t) => t.passes).length;
  const lines = [
    `${name} [${prd.mode}] — ${done}/${prd.tasks.length} tasks pass` +
      (pid !== null ? ` — RUNNING (pid ${pid})` : st ? ` — ${st.state} (iteration ${st.iteration}, ${st.updatedAt.slice(0, 16)})` : " — not started"),
  ];
  if (prd.description) lines.push(`  goal: ${prd.description}`);
  const sz = await specSize(base, name);
  if (sz !== null) lines.push(`  spec: ${STATE_DIR}/${name}/${SPEC_FILE} (${Math.max(1, Math.round(sz / 1024))} KB)`);
  if (cfg && prd.mode === "research") lines.push(`  output: ${outputDirOf(name, cfg)}/ (findings/, report.md)`);
  if (cfg) {
    const lim = limitsOf(cfg);
    lines.push(`  limits: ~${lim.contextTokens} tokens of context, ${lim.toolBudget} tool calls per iteration`);
  }
  if (cfg) lines.push(`  verifier: ${prd.mode === "code" ? cfg.check ?? "(none — trusts the worker's claim)" : "checker pass"}; max ${cfg.maxIterations} iterations`);
  if (st?.message) lines.push(`  note: ${st.message}`);
  for (const t of [...prd.tasks].sort((a, b) => a.priority - b.priority)) {
    lines.push(`  [${t.passes ? "x" : " "}] ${t.id} ${t.title}${t.failures ? ` (failed ${t.failures}x)` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

function criteriaText(t: RalphTask): string {
  return t.acceptanceCriteria.length ? t.acceptanceCriteria.map((c) => `- ${c}`).join("\n") : "- (none given — use judgment)";
}

/** One line pointing iterations at the run's spec (not inlined: it can be huge). */
function specLine(relDir: string, hasSpec: boolean): string {
  return hasSpec
    ? `Project spec: ${relDir}/${SPEC_FILE} — read the parts relevant to your task (overview/goals/non-goals/technical considerations first; read_file returns at most 64 KiB per call, use offset for more). It is the source of truth for what to build.`
    : "";
}

export function workerPrompt(prd: RalphPrd, cfg: RalphConfig, task: RalphTask, relDir: string, outDir: string, hasSpec = false): string {
  const head = [
    "You are ONE iteration of an autonomous Ralph loop. You have a fresh context: everything you know comes from files.",
    `Run directory: ${relDir}/  (relative to the current directory)`,
    `Overall goal: ${prd.description || prd.name}`,
    specLine(relDir, hasSpec),
    `Budget: this iteration has about ${limitsOf(cfg).toolBudget} tool calls and a ~${limitsOf(cfg).contextTokens}-token context. Tool outputs are truncated and old ones are dropped, so read only what you need, in small slices, and finish early.`,
    `Your task: ${task.id} — ${task.title}`,
    task.description ?? "",
    "Acceptance criteria:",
    criteriaText(task),
    "",
    `1. Read ${relDir}/progress.txt first (start with its "Codebase Patterns" section) to learn what earlier iterations found.`,
  ];
  const retry = task.lastFailure
    ? ["", `A previous attempt at this task FAILED verification:\n${task.lastFailure}\nFix that this time.`]
    : [];
  const body =
    prd.mode === "code"
      ? [
          "2. Implement ONLY this task, with small focused changes that follow the existing code conventions.",
          cfg.check
            ? `3. Verify with run_command — the loop will run \`${cfg.check}\` and the task only counts if it exits 0. Run its parts yourself (one command per call, no shell operators) and fix failures.`
            : "3. Verify your work with run_command (build/tests) where the project has them.",
          "4. Record reusable learnings (patterns, gotchas, how to run things) with ralph_note.",
          "5. When — and only when — the work is done, call ralph_complete_task with a short summary. Do NOT edit prd.json and do NOT commit: the loop verifies and commits.",
        ]
      : [
          `2. Research ONLY this task using the tools available to you (read only the earlier findings you need from ${outDir}/findings/). Write your findings to ${outDir}/findings/${task.id}.md (create the file with write_file): concrete facts, with source/provenance for each claim, organised to address every acceptance criterion explicitly. State uncertainty honestly; do not invent sources.`,
          "3. Record reusable learnings (good sources, dead ends, terminology) with ralph_note.",
          "4. When — and only when — every criterion is addressed, call ralph_complete_task with a short summary. A separate checker will judge the findings file against the criteria. Do NOT edit prd.json.",
        ];
  const split =
    "If you realise this task cannot be finished within the budget, do NOT push on: call ralph_split_task with 2-4 smaller tasks that together cover the whole task, then stop.";
  return [...head, ...body, split, ...retry].filter((l) => l !== "").join("\n");
}

export function checkerPrompt(prd: RalphPrd, task: RalphTask, outDir: string, relDir = "", hasSpec = false): string {
  return [
    "You are the CHECKER in a Ralph research loop, with a fresh context. Judge strictly and independently; do not do the research yourself.",
    specLine(relDir, hasSpec),
    `Task ${task.id} — ${task.title}`,
    task.description ?? "",
    "Acceptance criteria:",
    criteriaText(task),
    `Read ${outDir}/findings/${task.id}.md (read_file). Check each criterion: is it addressed with concrete, sourced, non-speculative content?`,
    "Then call ralph_verdict exactly once with pass=true only if EVERY criterion is met; otherwise pass=false and a reason listing precisely what is missing so the next attempt can fix it.",
  ].filter((l) => l !== "").join("\n");
}

export function synthesisPrompt(prd: RalphPrd, relDir: string, outDir: string, hasSpec = false): string {
  return [
    "You are the final iteration of a Ralph research run, with a fresh context. Every task now passes.",
    `Goal: ${prd.description || prd.name}`,
    specLine(relDir, hasSpec),
    `Read ${relDir}/progress.txt and every file in ${outDir}/findings/ (${prd.tasks.map((t) => t.id).join(", ")}).`,
    `Write the final report to ${outDir}/report.md (write_file): an executive summary first, then the findings organised by theme, keeping sources, with open questions and recommended next steps. Then call ralph_complete_task with a one-line summary.`,
  ].filter((l) => l !== "").join("\n");
}

export function splitterPrompt(prd: RalphPrd, cfg: RalphConfig, task: RalphTask, relDir: string, outDir: string, hasSpec: boolean, why: string): string {
  const lim = limitsOf(cfg);
  return [
    "You are the SPLITTER in a Ralph loop, with a fresh context. Do not do the task yourself.",
    `Task ${task.id} — ${task.title} did not fit in one iteration (${why}). An iteration has only ~${lim.contextTokens} tokens of context and ${lim.toolBudget} tool calls.`,
    task.description ?? "",
    "Its acceptance criteria:",
    criteriaText(task),
    specLine(relDir, hasSpec),
    prd.mode === "research" ? `Partial findings may exist in ${outDir}/findings/ (read_file) — do not redo work already there.` : "",
    "Call ralph_split_task ONCE with 2-4 smaller tasks that together cover everything the original required. Each: one deliverable, 2-4 verifiable criteria, at most ~3 sources/files to consume, and a description (<600 chars) naming exactly what to do. Then stop.",
  ].filter((l) => l !== "").join("\n");
}

/**
 * Prompt that makes the model draft a run's task list (PRD-style). Built in —
 * not a skill — because skills load from the workspace's ./skills/ and may be
 * absent. `interactive` (chat) lets it ask clarifying questions first;
 * headless (`ralph init --plan`) must decide alone and log its assumptions.
 */
export function planPrompt(prd: RalphPrd, hasSpec: boolean, interactive: boolean, relDir: string, cfg: Partial<RalphConfig> = {}): string {
  const name = prd.name;
  const lim = limitsOf(cfg);
  return [
    `Plan the tasks for the existing Ralph run "${name}" (mode: ${prd.mode}). Goal: ${prd.description || "(see the spec)"}`,
    hasSpec
      ? `The project description is ${relDir}/${SPEC_FILE} — read ALL of it first (read_file returns at most 64 KiB per call; use offset for the rest).`
      : "",
    interactive
      ? "If the problem, scope, success criteria or technical constraints are unclear, FIRST ask me 3-5 short clarifying questions, each with lettered options (A, B, C, D) so I can answer like '1A, 2C', and wait for my answers before adding tasks. If everything is already clear, skip the questions."
      : `You cannot ask questions in this mode: make reasonable assumptions and record each one with ralph_note (run "${name}"), prefixed "Assumption:".`,
    "Task rules:",
    `- SIZE: every iteration runs in a fresh context of only ~${lim.contextTokens} tokens with at most ${lim.toolBudget} tool calls (tool outputs are truncated), so it can read just a few pages/files. A task must fit comfortably: ONE deliverable (one output file), 2-4 acceptance criteria, at most ~3 sources/pages/files to consume. If a topic needs more, make several tasks (one per source, topic, option, model class, module...). Tasks that are too coarse are REJECTED by ralph_add_task and ralph_create (more than 4 criteria, '5+' / 'at least 4' of anything, several output files, a description over 600 chars).`,
    "- COUNT: a goal with several questions normally becomes 10-25 small tasks, not 4-6. Split per question AND per option/source group; give each comparison table or summary its own task that reads earlier findings. When in doubt, split further.",
    "- Example (research): instead of 'Collect 5+ sources on hardware' make 'Find 2 recent sources on Mac mini LLM speed', 'Find 2 recent sources on NVIDIA 4090/5090 LLM speed', 'Find 2 sources on AMD/other options', then 'Table: bandwidth and tokens/sec per option, from the earlier findings'.",
    "- Order by dependency (schema -> backend -> UI; survey -> compare). Criteria must be verifiable by running a command or inspecting a file — never 'works correctly'.",
    hasSpec
      ? "- In each task's description, name the spec section(s)/requirements it implements and the files or areas involved, so the iteration reads only what it needs."
      : "",
    prd.mode === "code"
      ? "- Inspect the project first (package.json, Makefile, README, existing tests). Call ralph_configure with `check` set to the real build+test command, and make 'the check passes' part of the criteria. If there are no tests, make the first task set up a test harness."
      : "- One research question per task; criteria must require cited sources and an explicit statement of uncertainty. Do not add a 'write the report' task — the loop adds a final synthesis step.",
    `Add the tasks with ralph_add_task (run "${name}"), one call per task, in order. Do NOT start the run.`,
    interactive ? "When done, show me the task list and wait for my go-ahead." : "When done, reply with a one-line summary.",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

export interface AgentRunArgs {
  prompt: string;
  env: Record<string, string>;
  timeoutMs: number;
  logFile: string;
}
export interface ExecResult {
  code: number;
  output: string;
}

export interface RunRalphOptions {
  base?: string;
  name: string;
  /** Override config.maxIterations. */
  maxIterations?: number;
  /** Flags forwarded to each child (e.g. --model). Default: setRalphForwardArgs(). */
  extraArgs?: string[];
  log?: (line: string) => void;
  runAgentFn?: (a: AgentRunArgs) => Promise<ExecResult>;
  execFn?: (cmd: string, cwd: string, timeoutMs: number) => Promise<ExecResult>;
  /** Install SIGINT/SIGTERM handlers (default true). */
  autoHandlers?: boolean;
  signal?: AbortSignal;
}

export interface RalphOutcome {
  state: RalphState;
  iterations: number;
  passed: number;
  total: number;
  message?: string;
}

function tail(s: string, n = 1500): string {
  const t = s.trim();
  return t.length > n ? "…" + t.slice(-n) : t;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const defaultExec = (cmd: string, cwd: string, timeoutMs: number): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn("sh", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const sink = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -2, output });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });

/** Env for an iteration child: role/task identity + context-window limits. */
export function ralphChildEnv(
  dir: string,
  name: string,
  cfg: RalphConfig,
  role: "worker" | "checker" | "splitter",
  taskId: string,
): Record<string, string> {
  const lim = limitsOf(cfg);
  return {
    SLASK_RALPH_DIR: dir,
    SLASK_RALPH_NAME: name,
    SLASK_RALPH_ROLE: role,
    SLASK_RALPH_TASK: taskId,
    SLASK_RALPH_ALLOW: cfg.allow.join(","),
    SLASK_MAX_TOOL_ITERATIONS: process.env.SLASK_MAX_TOOL_ITERATIONS ?? String(lim.toolBudget),
    SLASK_MAX_TOKENS: process.env.SLASK_MAX_TOKENS ?? String(lim.maxTokens),
    SLASK_CONTEXT_CHARS: process.env.SLASK_CONTEXT_CHARS ?? String(lim.contextChars),
    SLASK_MAX_TOOL_RESULT_CHARS: process.env.SLASK_MAX_TOOL_RESULT_CHARS ?? String(lim.resultChars),
  };
}

/** Last non-empty line of a child's output, ANSI-stripped (the real error, if any). */
export function lastLine(out: string): string {
  const lines = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const l = lines[lines.length - 1] ?? "";
  return l.length > 300 ? l.slice(0, 297) + "..." : l;
}

const TOO_BIG_RE = /token limit|safety cap|stopped after \d+ tool calls|context (?:window|length)|maximum context|exceed.*context/i;

export async function runRalph(opts: RunRalphOptions): Promise<RalphOutcome> {
  const base = opts.base ?? process.cwd();
  const name = validateName(opts.name);
  const log = opts.log ?? console.log;
  const exec = opts.execFn ?? defaultExec;
  const dir = runDir(base, name);
  const relDir = relative(base, dir) || ".";
  const extraArgs = opts.extraArgs ?? forwardArgs;
  const cfg = await loadConfig(base, name);
  const maxIterations = opts.maxIterations ?? cfg.maxIterations;
  const outDir = outputDirOf(name, cfg);

  // lock: one loop per run
  const other = await readPid(base, name);
  if (other !== null && other !== process.pid) {
    throw new Error(`ralph run "${name}" is already running (pid ${other})`);
  }
  await writeFile(join(dir, "run.pid"), String(process.pid));

  // abort handling: SIGINT/SIGTERM (or opts.signal) stop after killing the in-flight child
  let aborted = false;
  let current: ChildProcess | null = null;
  const abort = () => {
    aborted = true;
    current?.kill("SIGTERM");
  };
  const onSig = () => abort();
  if (opts.autoHandlers ?? true) {
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
  }
  opts.signal?.addEventListener("abort", abort);

  const runAgent =
    opts.runAgentFn ??
    ((a: AgentRunArgs) =>
      runCliChild(["--prompt", a.prompt, "--quiet", ...extraArgs], {
        timeoutMs: a.timeoutMs,
        env: a.env,
        capture: true,
        onOutput: (chunk) => void appendFile(a.logFile, chunk).catch(() => {}),
        onSpawn: (c) => {
          current = c;
        },
      }));

  const childEnv = (role: "worker" | "checker" | "splitter", task?: RalphTask): Record<string, string> =>
    ralphChildEnv(dir, name, cfg, role, task?.id ?? "");

  let iteration = 0;
  const finish = async (state: RalphState, message?: string): Promise<RalphOutcome> => {
    const prd = await loadPrd(base, name);
    await writeStatus(base, name, { state, iteration, message });
    await writeFile(join(dir, "run.pid"), "").catch(() => {});
    log(`\nralph "${name}": ${state}${message ? ` — ${message}` : ""} (${prd.tasks.filter((t) => t.passes).length}/${prd.tasks.length} tasks pass)`);
    return {
      state,
      iterations: iteration,
      passed: prd.tasks.filter((t) => t.passes).length,
      total: prd.tasks.length,
      message,
    };
  };

  try {
    await writeStatus(base, name, { state: "running", iteration: 0 });
    const first = await loadPrd(base, name);
    log(`ralph "${name}" [${first.mode}] — ${first.tasks.length} task(s), max ${maxIterations} iteration(s)`);

    if (first.mode === "code" && cfg.commit && first.branchName) {
      const co = await exec(`git checkout ${shq(first.branchName)} || git checkout -b ${shq(first.branchName)}`, base, 30_000);
      if (co.code !== 0) log(`  ⚠ could not switch to branch ${first.branchName}: ${tail(co.output, 300)}`);
    }

    while (true) {
      if (aborted) return await finish("stopped", "interrupted");
      const prd = await loadPrd(base, name);
      const task = pickNext(prd);
      if (task === undefined) break;
      if (iteration >= maxIterations) {
        return await finish("max-iterations", `reached ${maxIterations} iterations`);
      }
      iteration++;
      const hasSpec = (await specSize(base, name)) !== null;
      const nn = String(iteration).padStart(2, "0");
      log(`\n=== iteration ${iteration}/${maxIterations}: ${task.id} ${task.title} ===`);
      await writeStatus(base, name, { state: "running", iteration, message: `${task.id} ${task.title}` });
      await clearVerdict(dir);
      task.claimed = false;
      await savePrd(base, prd);

      const logFile = join(dir, "iterations", `${nn}.log`);
      await mkdir(join(dir, "iterations"), { recursive: true });
      const w = await runAgent({
        prompt: workerPrompt(prd, cfg, task, relDir, outDir, hasSpec),
        env: childEnv("worker", task),
        timeoutMs: cfg.timeoutS * 1000,
        logFile,
      });
      current = null;
      if (aborted) return await finish("stopped", "interrupted");

      const after = await loadPrd(base, name);
      const t = after.tasks.find((x) => x.id === task.id);
      if (t === undefined) {
        await appendProgress(base, name, `\n## ${new Date().toISOString()} — ${task.id} was split or removed during the iteration`);
        log(`  ↳ ${task.id} was split into smaller tasks`);
        continue;
      }

      let ok = false;
      let reason = "";
      if (t.claimed !== true) {
        const tooBig = w.code === -1 || TOO_BIG_RE.test(w.output);
        reason = `worker ended (exit ${w.code}) without calling ralph_complete_task${lastLine(w.output) ? ` — last output: ${lastLine(w.output)}` : ""}`;
        // Ran out of context / tool budget / time: have a splitter break the task up.
        if (tooBig && t.id.split(".").length - 1 < MAX_SPLIT_DEPTH) {
          log(`  ⚠ ${t.id} did not fit in one iteration (${lastLine(w.output) || `exit ${w.code}`}) — splitting it`);
          await runAgent({
            prompt: splitterPrompt(after, cfg, t, relDir, outDir, hasSpec, lastLine(w.output) || `exit ${w.code}`),
            env: childEnv("splitter", t),
            timeoutMs: cfg.timeoutS * 1000,
            logFile: join(dir, "iterations", `${nn}-split.log`),
          });
          current = null;
          if (aborted) return await finish("stopped", "interrupted");
          const reloaded = await loadPrd(base, name);
          if (!reloaded.tasks.some((x) => x.id === t.id)) {
            log(`  ↳ ${t.id} split into smaller tasks`);
            continue;
          }
          reason += " (automatic split failed)";
        }
      } else if (after.mode === "code") {
        if (cfg.check) {
          log(`  verifying: ${cfg.check}`);
          const c = await exec(cfg.check, base, cfg.timeoutS * 1000);
          ok = c.code === 0;
          if (!ok) reason = `check \`${cfg.check}\` failed (exit ${c.code}):\n${tail(c.output)}`;
        } else {
          ok = true;
        }
      } else {
        log("  verifying: checker pass");
        await runAgent({
          prompt: checkerPrompt(after, t, outDir, relDir, hasSpec),
          env: childEnv("checker", t),
          timeoutMs: cfg.timeoutS * 1000,
          logFile: join(dir, "iterations", `${nn}-check.log`),
        });
        current = null;
        if (aborted) return await finish("stopped", "interrupted");
        const v = await readVerdict(dir);
        if (v === null) reason = "checker produced no verdict";
        else {
          ok = v.pass;
          if (!ok) reason = `checker rejected: ${v.reason}`;
        }
      }

      const stamp = new Date().toISOString();
      if (ok) {
        t.passes = true;
        t.claimed = false;
        t.failures = 0;
        t.lastFailure = undefined;
        await savePrd(base, after);
        let commitNote = "";
        if (after.mode === "code" && cfg.commit) commitNote = await commitTask(exec, base, t);
        await appendProgress(base, name, `\n## ${stamp} — ${t.id} ${t.title}: PASS${commitNote ? ` (${commitNote})` : ""}\n${t.notes ?? ""}`);
        log(`  ✓ ${t.id} passes${commitNote ? ` (${commitNote})` : ""}`);
      } else {
        t.claimed = false;
        t.failures = (t.failures ?? 0) + 1;
        t.lastFailure = reason;
        await savePrd(base, after);
        await appendProgress(base, name, `\n## ${stamp} — ${t.id} ${t.title}: FAIL #${t.failures}\n${reason}`);
        log(`  ✗ ${t.id} failed (${t.failures}/${cfg.maxFailures}): ${tail(reason, 300)}`);
        if (t.failures >= cfg.maxFailures) {
          return await finish("stuck", `${t.id} failed ${t.failures} times in a row`);
        }
      }
    }

    // every task passes
    const done = await loadPrd(base, name);
    if (done.mode === "research" && done.tasks.length > 0) {
      log("\n=== final synthesis ===");
      await runAgent({
        prompt: synthesisPrompt(done, relDir, outDir, (await specSize(base, name)) !== null),
        env: childEnv("worker"),
        timeoutMs: cfg.timeoutS * 1000,
        logFile: join(dir, "iterations", "report.log"),
      });
      current = null;
    }
    return await finish("done", done.mode === "research" ? `report: ${outDir}/report.md` : undefined);
  } finally {
    if (opts.autoHandlers ?? true) {
      process.off("SIGINT", onSig);
      process.off("SIGTERM", onSig);
    }
    opts.signal?.removeEventListener("abort", abort);
    await writeFile(join(dir, "run.pid"), "").catch(() => {});
  }
}

async function commitTask(
  exec: NonNullable<RunRalphOptions["execFn"]>,
  base: string,
  t: RalphTask,
): Promise<string> {
  const st = await exec("git status --porcelain", base, 30_000);
  if (st.code !== 0) return "not a git repo — commit skipped";
  if (st.output.trim() === "") return "nothing to commit";
  const add = await exec(`git add -A -- . ':!${STATE_DIR}/*/iterations' ':!${STATE_DIR}/*/run.*'`, base, 60_000);
  if (add.code !== 0) return `git add failed: ${tail(add.output, 200)}`;
  const c = await exec(`git commit -m ${shq(`feat: [${t.id}] - ${t.title}`)}`, base, 60_000);
  return c.code === 0 ? "committed" : `git commit failed: ${tail(c.output, 200)}`;
}

interface Verdict {
  taskId: string;
  pass: boolean;
  reason: string;
}
async function readVerdict(dir: string): Promise<Verdict | null> {
  try {
    return await readJson<Verdict>(join(dir, "verdict.json"));
  } catch {
    return null;
  }
}
async function clearVerdict(dir: string): Promise<void> {
  await writeFile(join(dir, "verdict.json"), "").catch(() => {});
}

// ---------------------------------------------------------------------------
// run_command: allow-listed, no shell (enabled only inside a ralph run)
// ---------------------------------------------------------------------------

const SHELL_TOKENS = new Set(["&&", "||", "|", ";", ">", ">>", "<", "&"]);

/** Split a command line into argv (single/double quotes, backslash escapes). */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error("unterminated quote in command");
  if (has || cur) out.push(cur);
  return out;
}

async function runCommand(base: string, command: string): Promise<string> {
  const argv = tokenize(command);
  if (argv.length === 0) throw new Error("`command` is empty");
  const bad = argv.find((a) => SHELL_TOKENS.has(a));
  if (bad) throw new Error(`there is no shell: "${bad}" is not supported — run one command per call`);
  const allow = (process.env.SLASK_RALPH_ALLOW ?? DEFAULT_ALLOW.join(",")).split(",").filter(Boolean);
  if (!allow.includes(argv[0])) {
    throw new Error(`command "${argv[0]}" is not allowed (allowed: ${allow.join(", ")})`);
  }
  const timeoutS = Number.parseInt(process.env.SLASK_RUN_COMMAND_TIMEOUT_S ?? "", 10) || 300;
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: base, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const sink = (b: Buffer) => {
      output += b.toString("utf8");
      if (output.length > 200_000) output = output.slice(-100_000);
    };
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutS * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${argv[0]}: ${e.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const body = tail(output, 32_000);
      resolve(`${timedOut ? `timed out after ${timeoutS}s` : `exit ${code}`}${body ? `\n${body}` : ""}`);
    });
  });
}

// ---------------------------------------------------------------------------
// tools (agent-invocable) — same pattern as schedule.ts
// ---------------------------------------------------------------------------

type Role = "chat" | "worker" | "checker" | "splitter";

export function ralphRole(): Role {
  if (!process.env.SLASK_RALPH_DIR) return "chat";
  const r = process.env.SLASK_RALPH_ROLE;
  return r === "checker" || r === "splitter" ? r : "worker";
}

const ROLE_TOOLS: Record<Role, string[]> = {
  chat: ["ralph_list", "ralph_status", "ralph_create", "ralph_add_task", "ralph_configure", "ralph_note", "ralph_start", "ralph_stop"],
  worker: ["ralph_status", "ralph_add_task", "ralph_note", "ralph_complete_task", "ralph_split_task", "run_command"],
  checker: ["ralph_status", "ralph_verdict"],
  splitter: ["ralph_status", "ralph_split_task"],
};

export const RALPH_TOOL_NAMES = [
  "ralph_list", "ralph_status", "ralph_create", "ralph_add_task", "ralph_configure", "ralph_start", "ralph_stop",
  "ralph_note", "ralph_complete_task", "ralph_split_task", "ralph_verdict", "run_command",
];

const RUN_PROP = {
  type: "string",
  description: "run name (see ralph_list); optional inside a ralph iteration",
};

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): OpenAiFunctionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required } } };
}

const taskSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    acceptanceCriteria: { type: "array", items: { type: "string" }, description: "concrete, verifiable criteria" },
  },
  required: ["title"],
};

export function ralphTools(): OpenAiFunctionTool[] {
  const all: OpenAiFunctionTool[] = [
    fn("ralph_list", "List all Ralph runs (autonomous task-list loops) with progress.", {}),
    fn("ralph_status", "Show a Ralph run's state, verifier and per-task pass/fail.", { run: RUN_PROP }),
    fn(
      "ralph_create",
      "Create a Ralph run: a named list of small tasks that an autonomous loop works through, one fresh-context iteration per task. " +
        "mode 'code' = implement + verify with a check command + commit; mode 'research' = investigate + write findings, judged by a checker. " +
        "Each task must be completable in ONE iteration and have concrete acceptance criteria. Does not start the run.",
      {
        name: { type: "string", description: "short run name (letters, digits, . _ -)" },
        mode: { type: "string", enum: ["code", "research"] },
        description: { type: "string", description: "the overall goal" },
        check: { type: "string", description: "code mode: shell command that must exit 0, e.g. 'npm run build && npm test'" },
        branchName: { type: "string", description: "code mode: git branch to work on" },
        outputDir: { type: "string", description: "research mode: visible folder (relative to the workspace) for findings/ and report.md; default ralph-<name>" },
        specFile: { type: "string", description: "optional project description file (workspace-relative path); copied into the run as spec.md for the iterations to read" },
        maxIterations: { type: "number" },
        tasks: { type: "array", items: taskSchema, description: "in priority order" },
      },
      ["name", "mode", "tasks"],
    ),
    fn("ralph_add_task", "Append a task to a Ralph run.", { run: RUN_PROP, ...(taskSchema.properties as object) }, ["title"]),
    fn(
      "ralph_configure",
      "Update an existing Ralph run: `check` (code verifier command that must exit 0, e.g. 'npm run build && npm test'), `description` (overall goal), `branchName`, `maxIterations`. Only change a run that is not running.",
      {
        run: RUN_PROP,
        check: { type: "string" },
        description: { type: "string" },
        branchName: { type: "string" },
        maxIterations: { type: "number" },
        contextTokens: { type: "number", description: "the model's context window in tokens (sizes tool-output caps and how small tasks must be)" },
        toolBudget: { type: "number", description: "max tool calls per iteration" },
      },
      ["run"],
    ),
    fn("ralph_start", "Start a Ralph run in a detached background process. Returns immediately; poll with ralph_status.", { run: RUN_PROP }, ["run"]),
    fn("ralph_stop", "Stop a running Ralph run (finishes by killing the current iteration).", { run: RUN_PROP }, ["run"]),
    fn("ralph_note", "Append a learning/pattern/gotcha (or, while planning, an assumption) to the run's progress.txt for later iterations.", { run: RUN_PROP, text: { type: "string" } }, ["text"]),
    fn(
      "ralph_complete_task",
      "Claim that the current task is finished. The loop then verifies it (check command / checker); you cannot mark it passing yourself.",
      { summary: { type: "string", description: "what you did / where the results are" } },
      ["summary"],
    ),
    fn(
      "ralph_split_task",
      "Replace the CURRENT task with 2-6 smaller tasks that together cover it (use when it cannot be finished within the iteration budget). Then stop working.",
      { run: RUN_PROP, tasks: { type: "array", items: taskSchema, description: "the smaller replacement tasks, in order" } },
      ["tasks"],
    ),
    fn(
      "ralph_verdict",
      "Checker only: judge the task. pass=true only if EVERY acceptance criterion is met.",
      { pass: { type: "boolean" }, reason: { type: "string", description: "when failing: exactly what is missing" } },
      ["pass", "reason"],
    ),
    fn(
      "run_command",
      "Run ONE command (no shell, no pipes/&&) in the project directory, e.g. `git status`, `npm test`. Only allow-listed programs run. Returns the exit code and output.",
      { command: { type: "string" } },
      ["command"],
    ),
  ];
  const allowed = new Set(ROLE_TOOLS[ralphRole()]);
  return all.filter((t) => allowed.has(t.function.name));
}

const text = (t: string): CallToolResult => ({ isError: false, content: [{ type: "text", text: t }] });
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function resolveRun(args: Record<string, unknown>): string {
  const n = str(args.run) || process.env.SLASK_RALPH_NAME || "";
  if (n === "") throw new Error("`run` is required (see ralph_list)");
  return n;
}

export async function callRalphTool(
  base: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  if (!ROLE_TOOLS[ralphRole()].includes(name)) {
    throw new Error(`tool ${name} is not available in this context`);
  }
  switch (name) {
    case "ralph_list": {
      const runs = await listRuns(base);
      if (runs.length === 0) return text("no ralph runs yet — create one with ralph_create");
      const lines: string[] = [];
      for (const r of runs) lines.push((await formatStatus(base, r)).split("\n")[0]);
      return text(lines.join("\n"));
    }
    case "ralph_status":
      return text(await formatStatus(base, resolveRun(args)));
    case "ralph_create": {
      const newTasks = Array.isArray(args.tasks) ? (args.tasks as NewTask[]) : [];
      assertGranular(((str(args.mode) || "code") as RalphMode), newTasks, {});
      const prd = await createRun(base, {
        name: str(args.name),
        mode: (str(args.mode) || "code") as RalphMode,
        description: str(args.description),
        check: str(args.check) || undefined,
        branchName: str(args.branchName) || undefined,
        outputDir: str(args.outputDir) || undefined,
        spec: str(args.specFile) ? await readSpecSource(base, str(args.specFile)) : undefined,
        maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
        tasks: Array.isArray(args.tasks) ? (args.tasks as NewTask[]) : [],
      });
      return text(`created ralph run "${prd.name}" [${prd.mode}] with ${prd.tasks.length} task(s). Start it with ralph_start (or \`slask-client ralph run ${prd.name}\`).`);
    }
    case "ralph_add_task": {
      const run = resolveRun(args);
      const nt: NewTask = {
        title: str(args.title),
        description: str(args.description) || undefined,
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? (args.acceptanceCriteria as string[]) : [],
      };
      assertGranular((await loadPrd(base, run)).mode, [nt], await loadConfig(base, run).catch(() => ({})));
      const t = await addTask(base, run, nt);
      return text(`added ${t.id}: ${t.title}`);
    }
    case "ralph_configure": {
      const run = resolveRun(args);
      const changed = await configureRun(base, run, {
        check: str(args.check) || undefined,
        description: str(args.description) || undefined,
        branchName: str(args.branchName) || undefined,
        maxIterations: typeof args.maxIterations === "number" ? args.maxIterations : undefined,
        contextTokens: typeof args.contextTokens === "number" ? args.contextTokens : undefined,
        toolBudget: typeof args.toolBudget === "number" ? args.toolBudget : undefined,
      });
      return text(`updated ${run}: ${changed.join(", ")}`);
    }
    case "ralph_start": {
      const run = resolveRun(args);
      const pid = await startDetached(base, run);
      return text(`started ralph run "${run}" (pid ${pid}); log: ${STATE_DIR}/${run}/run.log`);
    }
    case "ralph_stop": {
      const run = resolveRun(args);
      return text((await stopRun(base, run)) ? `stopping "${run}"` : `"${run}" is not running`);
    }
    case "ralph_note": {
      const t = str(args.text);
      if (t === "") throw new Error("`text` is required");
      await appendProgress(base, resolveRun(args), `\n- ${process.env.SLASK_RALPH_TASK ? `[${process.env.SLASK_RALPH_TASK}] ` : ""}${t}`);
      return text("noted");
    }
    case "ralph_complete_task": {
      const run = resolveRun(args);
      const id = process.env.SLASK_RALPH_TASK ?? "";
      const prd = await loadPrd(base, run);
      const t = prd.tasks.find((x) => x.id === id);
      if (t === undefined) {
        // final synthesis iteration has no task: nothing to claim
        return text("recorded");
      }
      t.claimed = true;
      t.notes = str(args.summary);
      await savePrd(base, prd);
      return text(`${id} claimed — the loop will verify it now; stop working.`);
    }
    case "ralph_split_task": {
      const run = resolveRun(args);
      const id = process.env.SLASK_RALPH_TASK ?? "";
      if (id === "") throw new Error("no current task to split");
      const ids = await splitTask(base, run, id, Array.isArray(args.tasks) ? (args.tasks as NewTask[]) : []);
      return text(`${id} replaced by ${ids.join(", ")} — the loop will work on them next; stop now.`);
    }
    case "ralph_verdict": {
      const run = resolveRun(args);
      const v: Verdict = {
        taskId: process.env.SLASK_RALPH_TASK ?? "",
        pass: args.pass === true,
        reason: str(args.reason),
      };
      await writeFile(join(runDir(base, run), "verdict.json"), JSON.stringify(v));
      return text(`verdict recorded: ${v.pass ? "pass" : "fail"}`);
    }
    case "run_command":
      return text(await runCommand(base, str(args.command)));
    default:
      throw new Error("unknown ralph tool " + JSON.stringify(name));
  }
}

export function ralphSystemBlock(): string {
  if (ralphRole() !== "chat") return "";
  return (
    "\n\nRalph runs: you can plan and manage autonomous *Ralph* loops — a task list worked through by repeated " +
    "fresh-context agent iterations until every task passes. Use `ralph_create` (mode 'code' for software work, " +
    "'research' for bigger investigations; split the goal into small tasks with concrete, verifiable acceptance " +
    "criteria; for code inspect the project first and set `check` to its build/test command; a project description " +
    "file can be attached with `specFile`), then `ralph_start`, and report progress with `ralph_status`. Also " +
    "`ralph_list`, `ralph_add_task`, `ralph_configure`, `ralph_stop`."
  );
}

// ---------------------------------------------------------------------------
// /ralph REPL command + `slask-client ralph` CLI
// ---------------------------------------------------------------------------

export const RALPH_HELP = [
  "  /ralph list                                      list runs",
  "  /ralph status <name>                             tasks + state of a run",
  "  /ralph init <name> [code|research] [spec-file]   create a run; spec-file = project description (e.g. a PRD)",
  "  /ralph spec <name> <file>                        attach / replace the project description",
  "  /ralph check <name> <command...>                 set the code verifier (must exit 0), e.g. npm run build && npm test",
  "  /ralph plan <name> [code|research] [goal...]     have the model draft the task list (asks questions first);",
  "                                                   creates the run if needed (then a goal is required)",
  "  /ralph add <name> <title...>                     append a task",
  "  /ralph split <name> <task-id>                    replace a too-big task with 2-4 smaller ones (model-assisted)",
  "  /ralph start <name>                              run the loop in the background",
  "  /ralph stop <name>                               stop a running loop",
  "",
  "Typical flow for a big project:",
  "  /ralph init shop code tasks/prd-shop.md   ->   /ralph plan shop   ->   /ralph start shop",
].join("\n");

export type RalphParse =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "status"; name: string }
  | { kind: "plan"; name: string; mode: RalphMode; goal: string }
  | { kind: "init"; name: string; mode: RalphMode; spec?: string }
  | { kind: "spec"; name: string; file: string }
  | { kind: "check"; name: string; command: string }
  | { kind: "split"; name: string; id: string }
  | { kind: "add"; name: string; title: string }
  | { kind: "start"; name: string }
  | { kind: "stop"; name: string }
  | { kind: "error"; message: string };

/** Parse a `/ralph …` REPL line; null when the line is not a /ralph command. */
export function parseRalphCmd(line: string): RalphParse | null {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts[0].toLowerCase() !== "/ralph") return null;
  if (parts.length === 1) return { kind: "help" };
  // The REPL takes plain positional arguments (like /schedule); `--flags` are
  // for the shell CLI only. Say so instead of silently misreading them.
  const flag = parts.slice(2).find((p) => /^--?[A-Za-z]/.test(p));
  if (flag !== undefined && !/^\/ralph\s+(add|plan|check)\b/i.test(line.trim())) {
    return { kind: "error", message: `"${flag}": options are not used in chat — see /ralph for the positional syntax` };
  }
  const sub = parts[1].toLowerCase();
  const name = parts[2];
  const need = (usage: string): RalphParse | null =>
    name === undefined ? { kind: "error", message: `usage: ${usage}` } : null;
  const modeAt = (i: number): RalphMode | undefined =>
    parts[i] === "code" || parts[i] === "research" ? parts[i] : undefined;
  switch (sub) {
    case "list":
      return { kind: "list" };
    case "status":
      return need("/ralph status <name>") ?? { kind: "status", name };
    case "start":
      return need("/ralph start <name>") ?? { kind: "start", name };
    case "stop":
      return need("/ralph stop <name>") ?? { kind: "stop", name };
    case "add": {
      const title = parts.slice(3).join(" ");
      if (name === undefined || title === "") return { kind: "error", message: "usage: /ralph add <name> <title...>" };
      return { kind: "add", name, title };
    }
    case "init": {
      const usage = "usage: /ralph init <name> [code|research] [spec-file]";
      if (name === undefined) return { kind: "error", message: usage };
      const mode = modeAt(3);
      const rest = parts.slice(mode ? 4 : 3);
      if (rest.length > 1) return { kind: "error", message: `${usage} (one spec file; paths with spaces are not supported)` };
      return { kind: "init", name, mode: mode ?? "code", spec: rest[0] };
    }
    case "spec": {
      if (name === undefined || parts[3] === undefined || parts.length > 4) {
        return { kind: "error", message: "usage: /ralph spec <name> <file>" };
      }
      return { kind: "spec", name, file: parts[3] };
    }
    case "split": {
      if (name === undefined || parts[3] === undefined || parts.length > 4) {
        return { kind: "error", message: "usage: /ralph split <name> <task-id> (e.g. /ralph split local-llm T2)" };
      }
      return { kind: "split", name, id: parts[3] };
    }
    case "check": {
      const command = parts.slice(3).join(" ");
      if (name === undefined || command === "") {
        return { kind: "error", message: "usage: /ralph check <name> <command...> (e.g. /ralph check shop npm run build && npm test)" };
      }
      return { kind: "check", name, command };
    }
    case "plan": {
      if (name === undefined) {
        return { kind: "error", message: "usage: /ralph plan <name> [code|research] [goal...]" };
      }
      const mode = modeAt(3);
      return { kind: "plan", name, mode: mode ?? "code", goal: parts.slice(mode ? 4 : 3).join(" ") };
    }
    default:
      return { kind: "error", message: `unknown /ralph command "${sub}" — try /ralph` };
  }
}

/**
 * Execute a parsed REPL command. Returns text to print, and/or a `prompt` the
 * REPL should send to the model (for `plan`).
 */
export async function runRalphRepl(
  p: RalphParse,
  base: string = process.cwd(),
  agentFn?: (a: AgentRunArgs) => Promise<ExecResult>,
): Promise<{ text?: string; prompt?: string }> {
  try {
    switch (p.kind) {
      case "help":
        return { text: "ralph runs:\n\n" + RALPH_HELP };
      case "error":
        return { text: p.message };
      case "list": {
        const runs = await listRuns(base);
        if (runs.length === 0) return { text: "no ralph runs yet — try /ralph plan <name> <goal>" };
        const lines: string[] = [];
        for (const r of runs) lines.push((await formatStatus(base, r)).split("\n")[0]);
        return { text: lines.join("\n") };
      }
      case "status":
        return { text: await formatStatus(base, p.name) };
      case "init": {
        const spec = p.spec ? await readSpecSource(base, p.spec) : undefined;
        await createRun(base, { name: p.name, mode: p.mode, spec });
        return { text: `created run "${p.name}" [${p.mode}]${spec ? " with spec" : ""} — ${spec ? `draft the tasks with /ralph plan ${p.name}, or ` : ""}add tasks with /ralph add ${p.name} <title>` };
      }
      case "spec":
        await setSpec(base, p.name, await readSpecSource(base, p.file));
        return { text: `spec for "${p.name}" replaced from ${p.file}` };
      case "split":
        return { text: (await splitViaAgent(base, p.name, p.id, agentFn)).text };
      case "check": {
        await configureRun(base, p.name, { check: p.command });
        return { text: `check for "${p.name}" set to: ${p.command}` };
      }
      case "add": {
        const t = await addTask(base, p.name, { title: p.title });
        return { text: `added ${t.id}: ${t.title}` };
      }
      case "start":
        return { text: `started "${p.name}" (pid ${await startDetached(base, p.name)}); log: ${STATE_DIR}/${p.name}/run.log` };
      case "stop":
        return { text: (await stopRun(base, p.name)) ? `stopping "${p.name}"` : `"${p.name}" is not running` };
      case "plan": {
        let exists = true;
        try {
          await loadPrd(base, p.name);
        } catch {
          exists = false;
        }
        if (!exists && !p.goal) {
          return {
            text: `no run named "${p.name}" yet — give a goal: /ralph plan ${p.name} [code|research] <goal...>, or create it from a description file first: /ralph init ${p.name} [code|research] <spec-file>`,
          };
        }
        if (!exists) await createRun(base, { name: p.name, mode: p.mode, description: p.goal });
        else if (p.goal && !(await loadPrd(base, p.name)).description) await configureRun(base, p.name, { description: p.goal });
        const prd = await loadPrd(base, p.name);
        const relDir = relative(base, runDir(base, p.name));
        const cfg = await loadConfig(base, p.name).catch(() => ({}));
        return { prompt: planPrompt(prd, (await specSize(base, p.name)) !== null, true, relDir, cfg) };
      }
    }
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e) };
  }
}

export interface RalphCliArgs {
  positional: string[]; // ["ralph", sub, name, ...]
  mode?: string;
  check?: string;
  max?: string;
  from?: string;
  criteria?: string;
  out?: string;
  spec?: string;
  plan?: boolean;
  context?: string;
  toolBudget?: string;
}

const CLI_USAGE =
  "usage: slask-client ralph <init|add|run|start|stop|status|list> [name] — " +
  "init <name> [--mode code|research] [--check <cmd>] [--from prd.json] [--spec <file> [--plan]] [--out <dir>] [--context <tokens>] [--tool-budget <n>]; spec <name> <file>; split <name> <task-id>; add <name> <title> [--criteria \"a;b\"]; " +
  "run <name> [--max N]; start|stop <name>; status [name]; list";

/** The `slask-client ralph …` subcommand. Returns the process exit code. */
export interface RalphCliDeps {
  /** Run a child agent (splitter) — default spawns this CLI. */
  agentFn?: (a: AgentRunArgs) => Promise<ExecResult>;
  /** Run the headless planning prompt for `name`; resolves with an exit code. */
  planFn?: (name: string, prompt: string) => Promise<number>;
}

const defaultPlanFn = async (name: string, prompt: string): Promise<number> =>
  (
    await runCliChild(["--prompt", prompt, "--quiet", ...forwardArgs], {
      timeoutMs: 30 * 60 * 1000,
      env: { SLASK_RALPH_NAME: name },
    })
  ).code;

const defaultAgentFn = async (a: AgentRunArgs): Promise<ExecResult> => {
  await mkdir(join(a.env.SLASK_RALPH_DIR, "iterations"), { recursive: true });
  return runCliChild(["--prompt", a.prompt, "--quiet", ...forwardArgs], {
    timeoutMs: a.timeoutMs,
    env: a.env,
    capture: true,
    onOutput: (c) => void appendFile(a.logFile, c).catch(() => {}),
  });
};

/**
 * Have a splitter child replace task `id` with 2-4 smaller tasks (shared by
 * `slask-client ralph split` and `/ralph split`). `done` = the task was split.
 */
export async function splitViaAgent(
  base: string,
  name: string,
  id: string,
  agentFn: (a: AgentRunArgs) => Promise<ExecResult> = defaultAgentFn,
): Promise<{ done: boolean; code: number; text: string }> {
  const prd = await loadPrd(base, name);
  const task = prd.tasks.find((x) => x.id === id);
  if (task === undefined) throw new Error(`no task ${id} in run "${name}"`);
  const cfg = await loadConfig(base, name);
  const dir = runDir(base, name);
  const prompt = splitterPrompt(
    prd, cfg, task, relative(base, dir), outputDirOf(name, cfg), (await specSize(base, name)) !== null,
    task.lastFailure ?? "manual split requested",
  );
  const env = ralphChildEnv(dir, name, cfg, "splitter", id);
  const r = await agentFn({ prompt, env, timeoutMs: cfg.timeoutS * 1000, logFile: join(dir, "iterations", `split-${id}.log`) });
  const done = !(await loadPrd(base, name)).tasks.some((x) => x.id === id);
  const text = done
    ? `split ${id}:\n${await formatStatus(base, name)}`
    : `${id} was not split (exit ${r.code}); see ${STATE_DIR}/${name}/iterations/split-${id}.log`;
  return { done, code: r.code, text };
}

export async function handleRalphCli(a: RalphCliArgs, base: string = process.cwd(), deps: RalphCliDeps = {}): Promise<number> {
  const [, sub, name] = a.positional;
  const log = (s: string) => console.log(s);
  switch (sub) {
    case "list": {
      const runs = await listRuns(base);
      if (runs.length === 0) log("no ralph runs yet — create one with: slask-client ralph init <name>");
      for (const r of runs) log((await formatStatus(base, r)).split("\n")[0]);
      return 0;
    }
    case "status":
      if (name === undefined) return handleRalphCli({ ...a, positional: ["ralph", "list"] }, base);
      log(await formatStatus(base, name));
      return 0;
    case "init": {
      if (name === undefined) throw new Error(CLI_USAGE);
      const mode = (a.mode ?? "code") as RalphMode;
      let tasks: RalphTask[] = [];
      let description: string | undefined;
      let branchName: string | undefined;
      if (a.from) {
        const raw = JSON.parse(await readFile(a.from, "utf8")) as { description?: string; branchName?: string };
        tasks = normalizeTasks(raw);
        description = raw.description;
        branchName = raw.branchName;
      }
      const spec = a.spec ? await readSpecSource(base, a.spec) : undefined;
      if (a.plan && spec === undefined && !description) {
        throw new Error("--plan needs something to plan from: give --spec <file> (or --from with a description)");
      }
      const prd = await createRun(base, {
        name,
        mode,
        check: a.check,
        outputDir: a.out,
        spec,
        description,
        branchName,
        tasks,
        maxIterations: a.max ? Number.parseInt(a.max, 10) : undefined,
        contextTokens: a.context ? Number.parseInt(a.context, 10) : undefined,
        toolBudget: a.toolBudget ? Number.parseInt(a.toolBudget, 10) : undefined,
      });
      if (a.from) {
        for (const t of prd.tasks) for (const p of lintTask(prd.mode, t)) log(`⚠ ${t.id} "${t.title}": ${p}`);
      }
      log(`created run "${prd.name}" [${prd.mode}] with ${prd.tasks.length} task(s) in ${STATE_DIR}/${prd.name}/${spec ? " (spec copied to spec.md)" : ""}`);
      if (a.plan) {
        log("planning tasks from the description (non-interactive)…");
        const prompt = planPrompt(prd, spec !== undefined, false, relative(base, runDir(base, name)), await loadConfig(base, name));
        const code = await (deps.planFn ?? defaultPlanFn)(name, prompt);
        log(await formatStatus(base, name));
        if (code !== 0) log(`⚠ planning exited with code ${code} — review the task list, or add tasks with \`ralph add\``);
        return code === 0 ? 0 : 1;
      }
      return 0;
    }
    case "spec": {
      const file = a.positional[3];
      if (name === undefined || file === undefined) throw new Error(CLI_USAGE);
      await setSpec(base, name, await readSpecSource(base, file));
      log(`spec for "${name}" replaced from ${file}`);
      return 0;
    }
    case "add": {
      const title = a.positional.slice(3).join(" ");
      if (name === undefined || title === "") throw new Error(CLI_USAGE);
      const t = await addTask(base, name, {
        title,
        acceptanceCriteria: a.criteria ? a.criteria.split(";").map((s) => s.trim()).filter(Boolean) : [],
      });
      log(`added ${t.id}: ${t.title}`);
      for (const p of lintTask((await loadPrd(base, name)).mode, t)) log(`⚠ ${t.id}: ${p}`);
      return 0;
    }
    case "split": {
      const id = a.positional[3];
      if (name === undefined || id === undefined) throw new Error(CLI_USAGE);
      const r = await splitViaAgent(base, name, id, deps.agentFn);
      log(r.text);
      return r.done ? 0 : 1;
    }
    case "run": {
      if (name === undefined) throw new Error(CLI_USAGE);
      const out = await runRalph({
        base,
        name,
        maxIterations: a.max ? Number.parseInt(a.max, 10) : undefined,
        log,
      });
      return out.state === "done" ? 0 : 1;
    }
    case "start":
      if (name === undefined) throw new Error(CLI_USAGE);
      log(`started "${name}" (pid ${await startDetached(base, name)}); log: ${STATE_DIR}/${name}/run.log`);
      return 0;
    case "stop":
      if (name === undefined) throw new Error(CLI_USAGE);
      log((await stopRun(base, name)) ? `stopping "${name}"` : `"${name}" is not running`);
      return 0;
    default:
      throw new Error(CLI_USAGE);
  }
}
