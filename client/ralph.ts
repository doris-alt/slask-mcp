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
import { createHash } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { appendFile, copyFile, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { runCliChild } from "./child.js";
import type { ChildProcess } from "./child.js";
import type { CallToolResult, OpenAiFunctionTool } from "./types.js";
import {
  DEFAULT_CONTEXT_TOKENS,
  envContextTokens,
} from "./agent.js";
import {
  flagValue,
  resolveModel,
} from "./models.js";
import type { ResolvedModel } from "./models.js";

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
  /** Prerequisite task ids that must pass before this task can be picked. */
  dependencies?: string[];
}

export interface RalphPrd {
  name: string;
  mode: RalphMode;
  description: string;
  branchName?: string;
  tasks: RalphTask[];
}

export interface RalphKnowledgeEntry {
  key: string;
  value: string;
  category: "pattern" | "decision" | "gotcha" | "infrastructure";
  updatedAt: string;
  taskOrigin?: string;
}

export interface RalphKnowledgeBase {
  entries: Record<string, RalphKnowledgeEntry>;
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
export const DEFAULT_TOOL_BUDGET = 25;
export const MAX_SPLIT_DEPTH = 2; // T2 -> T2.1 -> T2.1.1, no further
// DEFAULT_CONTEXT_TOKENS / envContextTokens live in agent.ts (shared model
// defaults) and are imported at the top of this file.

/**
 * Per-iteration limits for a run. The context window is the *smallest* of the
 * role model's declared `contextTokens` (if set) and MAX_CONTEXT_TOKENS from
 * the environment (if set), so a run never plans or reads beyond the model's
 * real window; default 32000 when neither is set. The `cfg.contextTokens`
 * (the run's own setting) is always taken, too, so a smaller run setting wins.
 * Every iteration role (worker, checker, splitter, report) gets these via
 * ralphChildEnv.
 *
 * `source` names which bound set the effective window: the role model's own
 * `contextTokens` (highest — the model's real ceiling), then the environment
 * `MAX_CONTEXT_TOKENS`, then the run's `contextTokens`, then the default.
 */
export function limitsOf(cfg: Partial<RalphConfig>, modelMaxContext?: number): {
  contextTokens: number;
  source: "model" | "env" | "config" | "default";
  toolBudget: number;
  contextChars: number;
  resultChars: number;
  maxTokens: number;
  /** Most sources/pages/files/items a single task may ask for (grows with the window). */
  maxItems: number;
} {
  const env = envContextTokens();
  const model = modelMaxContext;
  const candidates = [model, env, cfg.contextTokens].filter(
    (n): n is number => n !== undefined,
  );
  const contextTokens = candidates.length ? Math.min(...candidates) : DEFAULT_CONTEXT_TOKENS;
  let source: "model" | "env" | "config" | "default";
  if (candidates.length === 0) {
    source = "default";
  } else if (model !== undefined && contextTokens === model) {
    source = "model";
  } else if (env !== undefined && contextTokens === env) {
    source = "env";
  } else if (cfg.contextTokens !== undefined && contextTokens === cfg.contextTokens) {
    source = "config";
  } else {
    source = "default";
  }
  const toolBudget = cfg.toolBudget ?? DEFAULT_TOOL_BUDGET;
  const contextChars = Math.floor(contextTokens * 2.5); // conservative chars/token (HTML/JSON-heavy output)
  return {
    contextTokens,
    source,
    toolBudget,
    contextChars,
    resultChars: Math.max(2000, Math.floor(contextChars / 10)),
    // reply allowance: ~1/8 of the window, 1k-16k (thinking models spend it before the tool call)
    maxTokens: Math.min(16384, Math.max(1024, Math.floor(contextTokens / 8))),
    maxItems: Math.min(8, Math.max(3, Math.floor(contextTokens / 10000))),
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

async function readKnowledgeBase(base: string, name: string): Promise<RalphKnowledgeBase> {
  try {
    return await readJson<RalphKnowledgeBase>(join(runDir(base, name), "knowledge.json"));
  } catch {
    return { entries: {} };
  }
}

async function saveKnowledgeBase(base: string, name: string, kb: RalphKnowledgeBase): Promise<void> {
  await atomicWrite(join(runDir(base, name), "knowledge.json"), JSON.stringify(kb, null, 2) + "\n");
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function parseKnowledgeFromNote(note: string): { category: RalphKnowledgeEntry["category"]; value: string } {
  const trimmed = note.trim();
  const bracket = trimmed.match(/^\[(pattern|decision|gotcha|infrastructure)\]\s*(.*)$/i);
  if (bracket) {
    const rawCategory = bracket[1].toLowerCase();
    const category = rawCategory as RalphKnowledgeEntry["category"];
    const value = (bracket[2] ?? "").trim();
    return { category, value: value || trimmed };
  }
  const colon = trimmed.match(/^(pattern|decision|gotcha|infrastructure)\s*:\s*(.*)$/i);
  if (colon) {
    const rawCategory = colon[1].toLowerCase();
    const category = rawCategory as RalphKnowledgeEntry["category"];
    const value = (colon[2] ?? "").trim();
    return { category, value: value || trimmed };
  }
  return { category: "gotcha", value: trimmed };
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
  /** Prerequisite task ids that must pass before this task can be picked. */
  dependencies?: string[];
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
    dependencies: (t.dependencies ?? []).map((d) => String(d).trim()).filter(Boolean),
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
    // contextTokens is written only when given: otherwise MAX_CONTEXT_TOKENS (.env) decides
    contextTokens: input.contextTokens,
    toolBudget: input.toolBudget ?? DEFAULT_TOOL_BUDGET,
  };
  for (const [k, v, min] of [["contextTokens", config.contextTokens, 2000], ["toolBudget", config.toolBudget, 3]] as const) {
    if (v !== undefined && (!Number.isInteger(v) || v < min)) throw new Error(`${k} must be an integer >= ${min}`);
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

/**
 * Re-open a task that already passed so the loop runs it again (and, in research
 * mode, has it re-checked). The old findings file stays; the worker is told why
 * via `notes`/`lastFailure` and progress.txt.
 */
export async function reopenTask(base: string, name: string, id: string, why?: string): Promise<RalphTask> {
  const prd = await loadPrd(base, name);
  const t = prd.tasks.find((x) => x.id === id);
  if (t === undefined) throw new Error(`no task "${id}" in run "${name}" (have: ${prd.tasks.map((x) => x.id).join(", ") || "none"})`);
  t.passes = false;
  t.claimed = false;
  t.failures = 0;
  t.lastFailure = why ? `re-opened: ${why}` : "re-opened for another attempt";
  await savePrd(base, prd);
  await appendProgress(base, name, `\n## ${new Date().toISOString()} — ${t.id} ${t.title}: RE-OPENED${why ? ` (${why})` : ""}`);
  return t;
}

export function pickNext(prd: RalphPrd): RalphTask | undefined {
  const pending = prd.tasks.filter((t) => !t.passes);
  if (pending.length === 0) return undefined;

  // A task is only ready if all its dependencies have passed.
  const ready = pending.filter((t) => {
    if (!t.dependencies) return true;
    return t.dependencies.every((depId) => {
      const dep = prd.tasks.find((x) => x.id === depId);
      return dep?.passes === true;
    });
  });

  if (ready.length === 0 && pending.length > 0) {
    // Deadlock or circular dependency: pick the highest priority pending task
    // to allow the worker to try and fix it or the splitter to break it.
    return pending.sort((a, b) => a.priority - b.priority)[0];
  }

  return ready.sort((a, b) => a.priority - b.priority)[0];
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
export function lintTask(mode: RalphMode, t: TaskLike, maxItems: number = limitsOf({}).maxItems): string[] {
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
    .filter((n) => n > maxItems);
  if (nums.length) probs.push(`asks for ${Math.max(...nums)}+ items — at most ${maxItems} per task; split by item/topic/source`);
  return probs;
}

/** Throw (so the planning model sees it and retries) when any task is too coarse. */
export function assertGranular(mode: RalphMode, tasks: TaskLike[], cfg: Partial<RalphConfig> = {}): void {
  const lim = limitsOf(cfg);
  const lines = tasks.flatMap((t, i) => lintTask(mode, t, lim.maxItems).map((p) => `- task ${i + 1} "${t.title ?? ""}": ${p}`));
  if (lines.length === 0) return;
  throw new Error(
    `too coarse for one iteration (each gets ~${lim.contextTokens} tokens of context and ${lim.toolBudget} tool calls):\n` +
      lines.join("\n") +
      `\nSplit these into smaller tasks (one deliverable, 2-4 criteria, at most ~${lim.maxItems} sources/files each) and call again.`,
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
    const src = lim.source === "env" ? " (MAX_CONTEXT_TOKENS)" : lim.source === "config" ? " (run setting)" : " (default; set MAX_CONTEXT_TOKENS in .env)";
    lines.push(`  limits: ~${lim.contextTokens} tokens of context, ${lim.toolBudget} tool calls per iteration${src}`);
  }
  if (cfg) lines.push(`  verifier: ${prd.mode === "code" ? cfg.check ?? "(none — trusts the worker's claim)" : "checker pass"}; max ${cfg.maxIterations} iterations per task`);
  if (st?.message) lines.push(`  note: ${st.message}`);
  for (const t of [...prd.tasks].sort((a, b) => a.priority - b.priority)) {
    lines.push(`  [${t.passes ? "x" : " "}] ${t.id} ${t.title}${t.failures ? ` (failed ${t.failures}x)` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

export function maintenancePrompt(
  prd: RalphPrd,
  cfg: RalphConfig,
  relDir: string,
  hasSpec = false,
): string {
  return [
    "You are the MAINTENANCE agent in a Ralph coding loop. All planned tasks have now passed verification.",
    "Your goal is to perform a final quality pass over the codebase to ensure consistency, remove redundancy, and polish the implementation.",
    specLine(relDir, hasSpec),
    `Overall Goal: ${prd.description || prd.name}`,
    "Tasks performed:",
    prd.tasks.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
    "",
    "Your instructions:",
    "1. Review the changes made across all tasks. Look for duplicated logic, inconsistent naming, or areas where the code can be simplified without changing behavior.",
    "2. Apply small, focused refactors to unify patterns and improve readability.",
    "3. Ensure that the code follows the project's conventions (as noted in progress.txt).",
    cfg.check
      ? `4. Verify your refactors with run_command — run \`${cfg.check}\` to ensure no regressions were introduced.`
      : "4. Verify your refactors with run_command (build/tests) to ensure no regressions were introduced.",
    "5. When finished, call ralph_complete_task with a summary of the refactors performed. Do NOT commit: the loop will handle the final commit.",
    "Keep changes conservative: do not change architecture or functionality, only polish and unify.",
  ].filter((l) => l !== "").join("\n");
}

export function verifierPrompt(
  prd: RalphPrd,
  task: RalphTask,
  failureOutput: string,
  relDir: string,
  hasSpec = false,
): string {
  return [
    "You are the VERIFIER in a Ralph coding loop. Your job is to analyze why a task's verification command failed and provide a structured bug report for the worker.",
    specLine(relDir, hasSpec),
    `Task ${task.id} — ${task.title}`,
    task.description ?? "",
    "Acceptance criteria:",
    criteriaText(task),
    `The verification command failed with the following output:\n---\n${failureOutput}\n---`,
    "Analyze the failure. Identify exactly which acceptance criterion is not met and why. Look for stack traces, lint errors, or logic failures.",
    "Your response must be a concise 'Bug Report' for the worker. Focus on:",
    "1. What exactly failed (the symptom).",
    "2. Where to look in the code (the cause).",
    "3. How to fix it to satisfy the criteria.",
    "Do not be generic. Be specific and technical.",
  ].filter((l) => l !== "").join("\n");
}

function criteriaText(t: RalphTask): string {
  return t.acceptanceCriteria.length ? t.acceptanceCriteria.map((c) => `- ${c}`).join("\n") : "- (none given — use judgment)";
}

/** One line pointing iterations at the run's spec (not inlined: it can be huge). */
function specLine(relDir: string, hasSpec: boolean): string {
  return hasSpec
    ? `Project spec: ${relDir}/${SPEC_FILE} — read the parts relevant to your task (overview/goals/non-goals/technical considerations first; read_file returns at most 64 KiB per call, use offset for more). It is the source of truth for what to build.`
    : "";
}

export function workerPrompt(
  prd: RalphPrd,
  cfg: RalphConfig,
  task: RalphTask,
  relDir: string,
  outDir: string,
  hasSpec = false,
  modelMaxContext?: number,
  kb: RalphKnowledgeBase = { entries: {} },
): string {
  const lim = limitsOf(cfg, modelMaxContext);
  const kbText = Object.values(kb.entries)
    .map((e) => `[${e.category}] ${e.key}: ${e.value} (origin: ${e.taskOrigin ?? "unknown"})`)
    .join("\n");

  const head = [
    "You are ONE iteration of an autonomous Ralph loop. You have a fresh context: everything you know comes from files.",
    `Run directory: ${relDir}/  (relative to the current directory)`,
    `Overall goal: ${prd.description || prd.name}`,
    specLine(relDir, hasSpec),
    `Budget: this iteration has about ${lim.toolBudget} tool calls and a ~${lim.contextTokens}-token context. Tool outputs are truncated and old ones are dropped, so read only what you need and finish early. Never read a whole large file: use grep_file to find the lines you need, then read_file with a small offset/bytes slice.`,
    `Your task: ${task.id} — ${task.title}`,
    task.description ?? "",
    "Acceptance criteria:",
    criteriaText(task),
    "",
    `1. Read ${relDir}/progress.txt first (start with its "Codebase Patterns" section) to learn what earlier iterations found.`,
    kbText ? `\n### Structured Project Knowledge\n${kbText}\n` : "",
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
          "4. Record reusable learnings (patterns, gotchas, how to run things) with ralph_note. Prefix the note with one of: [pattern], [decision], [gotcha], [infrastructure] (e.g. [pattern] Use atomic writes for files).",
          "5. When — and only when — the work is done, call ralph_complete_task with a short summary. Do NOT edit prd.json and do NOT commit: the loop verifies and commits.",
        ]
      : [
          `2. Research ONLY this task using the tools available to you (read only the earlier findings you need from ${outDir}/findings/). Write your findings to ${outDir}/findings/${task.id}.md (create the file with write_file): concrete facts, with source/provenance for each claim, organised to address every acceptance criterion explicitly. State uncertainty honestly; do not invent sources.`,
          "3. Record reusable learnings (good sources, dead ends, terminology) with ralph_note. Prefix with one of: [pattern], [decision], [gotcha], [infrastructure].",
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

export function splitterPrompt(
  prd: RalphPrd,
  cfg: RalphConfig,
  task: RalphTask,
  relDir: string,
  outDir: string,
  hasSpec: boolean,
  why: string,
  modelMaxContext?: number,
): string {
  const lim = limitsOf(cfg, modelMaxContext);
  return [
    "You are the SPLITTER in a Ralph loop, with a fresh context. Your ONLY job is one call to ralph_split_task. Do NOT do the task, and do NOT write analysis, notes or summaries in your reply.",
    `Task ${task.id} — ${task.title} did not fit in one iteration (${why}). An iteration has only ~${lim.contextTokens} tokens of context and ${lim.toolBudget} tool calls.`,
    task.description ?? "",
    "Its acceptance criteria:",
    criteriaText(task),
    `You may read ONLY ${relDir}/prd.json (the task list; short) and ${hasSpec ? `${relDir}/${SPEC_FILE} (the project spec)` : "(there is no spec)"}. Any other file — especially findings, reports and logs under ${outDir}/ — is refused: it is irrelevant for splitting and large. For the spec use grep_file (pattern) or read_file with a small offset/bytes slice (at most ${SPLIT_READ_BYTES} bytes per read); never read the whole spec.`,
    `Call ralph_split_task ONCE with 2-4 smaller tasks that together cover everything the original required. Each: one deliverable, 2-4 verifiable criteria, at most ~${lim.maxItems} sources/files to consume, and a description (<600 chars) naming exactly what to do. If the call is rejected, fix the tasks it complains about and call again. Then stop.`,
  ].filter((l) => l !== "").join("\n");
}

/**
 * Prompt that makes the model draft a run's task list (PRD-style). Built in —
 * not a skill — because skills load from the workspace's ./skills/ and may be
 * absent. `interactive` (chat) lets it ask clarifying questions first;
 * headless (`ralph init --plan`) must decide alone and log its assumptions.
 */
export function planPrompt(
  prd: RalphPrd,
  hasSpec: boolean,
  interactive: boolean,
  relDir: string,
  cfg: Partial<RalphConfig> = {},
  modelMaxContext?: number,
): string {
  const name = prd.name;
  const lim = limitsOf(cfg, modelMaxContext);
  return [
    `Plan the tasks for the existing Ralph run "${name}" (mode: ${prd.mode}). Goal: ${prd.description || "(see the spec)"}`,
    hasSpec
      ? `The project description is ${relDir}/${SPEC_FILE} — read ALL of it first (read_file returns at most 64 KiB per call; use offset for the rest).`
      : "",
    interactive
      ? "If the problem, scope, success criteria or technical constraints are unclear, FIRST ask me 3-5 short clarifying questions, each with lettered options (A, B, C, D) so I can answer like '1A, 2C', and wait for my answers before adding tasks. If everything is already clear, skip the questions."
      : `You cannot ask questions in this mode: make reasonable assumptions and record each one with ralph_note (run "${name}"), prefixed "Assumption:".`,
    "Task rules:",
    `- SIZE: every iteration runs in a fresh context of only ~${lim.contextTokens} tokens with at most ${lim.toolBudget} tool calls (tool outputs are truncated), so it can read just a few pages/files. A task must fit comfortably: ONE deliverable (one output file), 2-4 acceptance criteria, at most ~${lim.maxItems} sources/pages/files to consume. If a topic needs more, make several tasks (one per source, topic, option, model class, module...). Tasks that are too coarse are REJECTED by ralph_add_task and ralph_create (more than 4 criteria, more than ${lim.maxItems} of anything ('at least ${lim.maxItems + 1}', '${lim.maxItems + 2}+'), several output files, a description over 600 chars).`,
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
  /**
   * The models.json selection (`provider/id`) to hand to the child via `--model`.
   * When set, the default runners append it *after* `forwardArgs`, so last-value-wins
   * makes the role's model override the top-level session default. Omitted = inherit
   * whatever `forwardArgs` (the session `--model`) already carried.
   */
  modelId?: string;
}
export interface ExecResult {
  code: number;
  output: string;
}

export interface RunRalphOptions {
  base?: string;
  name: string;
  /** Override config.maxIterations (max iterations per task). */
  maxIterations?: number;
  /** The `--base-url` session override, used only when the selected entry has no base of its own. */
  baseOverride?: string | null;
  /**
   * models.json selection (`provider/id`) for the top-level / role-default model
   * (the `--model` flag). Omitted/null = resolve the file default (the first
   * provider's first model).
   */
  modelId?: string | null;
  /** models.json selection (`provider/id`) for the *worker* role (fresh-context iterations). Omitted = modelId. */
  workerModelId?: string | null;
  /** models.json selection (`provider/id`) for the *checker* role (research verification). Omitted = modelId. */
  checkerModelId?: string | null;
  /** models.json selection (`provider/id`) for the *splitter* role (task splitting). Omitted = modelId. */
  splitterModelId?: string | null;
  /** models.json selection (`provider/id`) for the *report* role (final synthesis). Omitted = modelId. */
  reportModelId?: string | null;
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

/**
 * Env for an iteration child: role/task identity + context-window limits.
 *
 * `modelMaxContext` (optional) is the resolved context window of the specific
 * role's model; it beats the env/config values when present. Omitted = legacy
 * behaviour (env > config > default).
 */
export function ralphChildEnv(
  dir: string,
  name: string,
  cfg: RalphConfig,
  role: "worker" | "checker" | "splitter",
  taskId: string,
  modelMaxContext?: number,
): Record<string, string> {
  const lim = limitsOf(cfg, modelMaxContext);
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

  // Resolve the role models up front — an unknown selection fails fast here with
  // the available provider/id list (strict). A role with no explicit selection
  // inherits the top model; the top level with no selection uses the file
  // default.
  const resolveRole = async (
    selection?: string | null,
    fallback?: ResolvedModel,
  ): Promise<ResolvedModel> =>
    selection
      ? resolveModel(base, { selection, baseOverride: opts.baseOverride ?? null })
      : (fallback ?? resolveModel(base, { baseOverride: opts.baseOverride ?? null }));
  const topModel = await resolveRole(opts.modelId);
  const workerModel = await resolveRole(opts.workerModelId, topModel);
  const checkerModel = await resolveRole(opts.checkerModelId, topModel);
  const splitterModel = await resolveRole(opts.splitterModelId, topModel);
  const reportModel = await resolveRole(opts.reportModelId, topModel);

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

  // The role's model is appended *after* `extraArgs`; the parser is
  // last-value-wins, so it overrides the top-level `--model` inherited from
  // `forwardArgs` when a specific role model was chosen.
  const runAgent =
    opts.runAgentFn ??
    ((a: AgentRunArgs) =>
      runCliChild(
        [
          "--prompt",
          a.prompt,
          "--quiet",
          ...extraArgs,
          ...(a.modelId ? ["--model", a.modelId] : []),
        ],
        {
          timeoutMs: a.timeoutMs,
          env: a.env,
          capture: true,
          onOutput: (chunk) => void appendFile(a.logFile, chunk).catch(() => {}),
          onSpawn: (c) => {
            current = c;
          },
        },
      ));

  const childEnv = (
    role: "worker" | "checker" | "splitter",
    task?: RalphTask,
    modelMaxContext?: number,
  ): Record<string, string> =>
    ralphChildEnv(dir, name, cfg, role, task?.id ?? "", modelMaxContext);

  // `iteration` counts every worker run in this loop (status.json, iterations/NN.log);
  // `attempt` counts tries at the CURRENT task: it restarts at 1 for each new task, so
  // maxIterations bounds how long one task may take, not the whole run.
  let iteration = 0;
  let attempt = 0;
  let attemptTask = "";
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
    log(`ralph "${name}" [${first.mode}] — ${first.tasks.length} task(s), max ${maxIterations} iteration(s) per task`);

    if (first.mode === "code" && cfg.commit && first.branchName) {
      const co = await exec(`git checkout ${shq(first.branchName)} || git checkout -b ${shq(first.branchName)}`, base, 30_000);
      if (co.code !== 0) log(`  ⚠ could not switch to branch ${first.branchName}: ${tail(co.output, 300)}`);
    }

    while (true) {
      if (aborted) return await finish("stopped", "interrupted");
      const prd = await loadPrd(base, name);
      const task = pickNext(prd);
      if (task === undefined) {
        // All tasks passed. Now run the maintenance phase for code mode.
        if (prd.mode === "code") {
          log(`\n=== Maintenance Phase: Polishing the codebase ===`);
          await writeStatus(base, name, { state: "running", iteration, message: "Maintenance Phase" });
          const maintenanceLog = join(dir, "iterations", "maintenance.log");
          await mkdir(join(dir, "iterations"), { recursive: true });

          const hasSpec = (await specSize(base, name)) !== null;
          const m = await runAgent({
            prompt: maintenancePrompt(prd, cfg, relDir, hasSpec),
            env: childEnv("worker", undefined, workerModel.contextWindow),
            timeoutMs: cfg.timeoutS * 1000,
            logFile: maintenanceLog,
            modelId: workerModel.selection,
          });
          current = null;
          if (aborted) return await finish("stopped", "interrupted");
          
          if (m.code === 0) {
            log(`  ✓ Maintenance complete.`);
            await appendProgress(base, name, `\n## ${new Date().toISOString()} — Maintenance: COMPLETED\n${m.output}`);
            // Final commit for the maintenance pass
            if (cfg.commit) {
              await exec(`git add -A && git commit -m "refactor: final maintenance polish"`, base, 30_000);
            }
          } else {
            log(`  ⚠ Maintenance ended with exit ${m.code}`);
          }
        }
        break;
      }
      if (task.id !== attemptTask) {
        attemptTask = task.id; // a new task (the previous one passed or was split): start counting afresh
        attempt = 0;
      }
      if (attempt >= maxIterations) {
        return await finish("max-iterations", `${task.id} used all ${maxIterations} iterations without passing`);
      }
      attempt++;
      iteration++;
      const hasSpec = (await specSize(base, name)) !== null;
      const nn = String(iteration).padStart(2, "0");
      log(`\n=== iteration ${attempt}/${maxIterations}: ${task.id} ${task.title} [run #${iteration}] ===`);
      await writeStatus(base, name, { state: "running", iteration, message: `${task.id} ${task.title} (iteration ${attempt}/${maxIterations})` });
      await clearVerdict(dir);
      task.claimed = false;
      await savePrd(base, prd);

      const logFile = join(dir, "iterations", `${nn}.log`);
      await mkdir(join(dir, "iterations"), { recursive: true });
      const w = await runAgent({
        prompt: workerPrompt(prd, cfg, task, relDir, outDir, hasSpec, workerModel.contextWindow, await readKnowledgeBase(base, name)),
        env: childEnv("worker", task, workerModel.contextWindow),
        timeoutMs: cfg.timeoutS * 1000,
        logFile,
        modelId: workerModel.selection,
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
          const why = lastLine(w.output) || `exit ${w.code}`;
          log(`  ⚠ ${t.id} did not fit in one iteration (${why}) — splitting it`);
          let sr: SplitOutcome;
          try {
            sr = await splitViaAgent(base, name, t.id, (a) => runAgent(a), why, splitterModel);
          } catch (e) {
            sr = { ok: false, ids: [], code: -2, reason: e instanceof Error ? e.message : String(e), text: "" };
          }
          current = null;
          if (aborted) return await finish("stopped", "interrupted");
          if (sr.ok) {
            log(`  ↳ ${t.id} split into ${sr.ids.join(", ")}`);
            continue;
          }
          log(`  ✗ automatic split of ${t.id} failed: ${sr.reason}`);
          reason += ` (automatic split failed: ${sr.reason})`;
        }
      } else if (after.mode === "code") {
        if (cfg.check) {
          log(`  verifying: ${cfg.check}`);
          const c = await exec(cfg.check, base, cfg.timeoutS * 1000);
          ok = c.code === 0;
          if (!ok) {
            // Improvement: Use Verifier Agent to analyze the failure
            log(`  ⚠ verification failed, running verifier agent...`);
            const vRes = await runAgent({
              prompt: verifierPrompt(after, t, c.output, relDir, hasSpec),
              env: childEnv("worker", t, workerModel.contextWindow), // Use worker-like env
              timeoutMs: cfg.timeoutS * 1000,
              logFile: join(dir, "iterations", `${nn}-verify.log`),
              modelId: workerModel.selection,
            });
            const vText = typeof (vRes as any)?.output === "string" ? (vRes as any).output : "";
            reason =
              `check \`${cfg.check}\` failed (exit ${c.code}):\n\nVERIFIER REPORT:\n${vText || "(empty)"}` +
              `\n\nRAW CHECK OUTPUT:\n${c.output}`;
          }
        } else {
          ok = true;
        }
      } else {
        log("  verifying: checker pass");
        await runAgent({
          prompt: checkerPrompt(after, t, outDir, relDir, hasSpec),
          env: childEnv("checker", t, checkerModel.contextWindow),
          timeoutMs: cfg.timeoutS * 1000,
          logFile: join(dir, "iterations", `${nn}-check.log`),
          modelId: checkerModel.selection,
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

        // Improvement: Handle Cascading Re-verification
        // Find tasks that depend on this one and mark them as failed/unpassed
        // so they are re-verified if this task changed the codebase.
        for (const other of after.tasks) {
          if (other.dependencies?.includes(t.id)) {
            other.passes = false;
            other.claimed = false;
            other.failures = 0;
            other.lastFailure = `dependency ${t.id} was updated; re-verification required`;
          }
        }

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
      await synthesize(base, name, cfg, done, runAgent, reportModel.contextWindow, reportModel.selection);
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

/**
 * The final research step: one fresh-context iteration that writes report.md from
 * every findings file. The previous report (if any) is kept as report.prev.md.
 */
async function synthesize(
  base: string,
  name: string,
  cfg: RalphConfig,
  prd: RalphPrd,
  runAgent: (a: AgentRunArgs) => Promise<ExecResult>,
  reportModelContextWindow?: number,
  reportModelSelection?: string,
): Promise<ExecResult> {
  const dir = runDir(base, name);
  const outDir = outputDirOf(name, cfg);
  await mkdir(join(dir, "iterations"), { recursive: true });
  await copyFile(join(base, outDir, "report.md"), join(base, outDir, "report.prev.md")).catch(() => {});
  // The report child keeps the `"worker"` env role (identical toolset — `ralphRole()`
  // collapses it to worker anyway, which is exactly what synthesis needs: the worker
  // toolset, including `ralph_complete_task`). The *empty* task is what marks it as
  // the synthesis step. The report model's context window is threaded through
  // `reportModelContextWindow` rather than flipping the env role.
  return runAgent({
    prompt: synthesisPrompt(prd, relative(base, dir) || ".", outDir, (await specSize(base, name)) !== null),
    env: ralphChildEnv(dir, name, cfg, "worker", "", reportModelContextWindow),
    timeoutMs: cfg.timeoutS * 1000,
    logFile: join(dir, "iterations", "report.log"),
    ...(reportModelSelection ? { modelId: reportModelSelection } : {}),
  });
}

export interface RunReportOptions {
  base?: string;
  name: string;
  /** models.json selection (`provider/id`) for the report role. Omitted/null = resolve the file default. */
  reportModelId?: string | null;
  /** The `--base-url` session override. Omitted/null = null. */
  baseOverride?: string | null;
  runAgentFn?: (a: AgentRunArgs) => Promise<ExecResult>;
  log?: (s: string) => void;
}

/** `ralph report`: redo just the final synthesis of a research run whose tasks all pass. */
export async function runReport(opts: RunReportOptions): Promise<{ ok: boolean; text: string }> {
  const base = opts.base ?? process.cwd();
  const name = validateName(opts.name);
  const prd = await loadPrd(base, name);
  if (prd.mode !== "research") throw new Error(`"${name}" is a ${prd.mode} run — only research runs have a report`);
  const pending = prd.tasks.filter((t) => !t.passes).map((t) => t.id);
  if (pending.length > 0) throw new Error(`tasks still pending: ${pending.join(", ")} — run \`ralph start ${name}\` to finish them (the report is written at the end)`);
  const other = await readPid(base, name);
  if (other !== null && other !== process.pid) throw new Error(`ralph run "${name}" is already running (pid ${other})`);
  const cfg = await loadConfig(base, name);
  const outDir = outputDirOf(name, cfg);
  const dir = runDir(base, name);
  // Resolve the report model (fail-fast on unknown selection, listing the
  // available provider/id entries).
  const reportModel = await resolveModel(base, {
    selection: opts.reportModelId ?? null,
    baseOverride: opts.baseOverride ?? null,
  });
  const runAgent =
    opts.runAgentFn ??
    ((a: AgentRunArgs) =>
      runCliChild(
        [
          "--prompt",
          a.prompt,
          "--quiet",
          ...forwardArgs,
          ...(a.modelId ? ["--model", a.modelId] : []),
        ],
        {
          timeoutMs: a.timeoutMs,
          env: a.env,
          capture: true,
          onOutput: (chunk) => void appendFile(a.logFile, chunk).catch(() => {}),
        },
      ));
  await writeFile(join(dir, "run.pid"), String(process.pid));
  const startedAt = Date.now();
  try {
    await writeStatus(base, name, { state: "running", iteration: 0, message: "rewriting the report" });
    (opts.log ?? console.log)(`rewriting ${outDir}/report.md from ${prd.tasks.length} task(s)…`);
    const r = await synthesize(base, name, cfg, prd, runAgent, reportModel.contextWindow, reportModel.selection);
    const written = await stat(join(base, outDir, "report.md")).then((s) => s.mtimeMs >= startedAt - 1000, () => false);
    const ok = r.code === 0 && written;
    const message = ok ? `report: ${outDir}/report.md` : `report not written (exit ${r.code}); log: ${STATE_DIR}/${name}/iterations/report.log`;
    await writeStatus(base, name, { state: ok ? "done" : "stuck", iteration: 0, message });
    return { ok, text: ok ? `✓ ${message} (previous version: ${outDir}/report.prev.md)` : `✗ ${message}` };
  } finally {
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
/** Outcome of the latest ralph_split_task call, so callers know how a split went. */
interface SplitResult {
  taskId: string;
  ok: boolean;
  ids?: string[];
  error?: string;
}
async function writeSplitResult(dir: string, r: SplitResult): Promise<void> {
  await writeFile(join(dir, "split-result.json"), JSON.stringify(r)).catch(() => {});
}
async function readSplitResult(dir: string): Promise<SplitResult | null> {
  try {
    return await readJson<SplitResult>(join(dir, "split-result.json"));
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
    dependencies: { type: "array", items: { type: "string" }, description: "prerequisite task ids that must pass first" },
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

      const run = resolveRun(args);
      const note = t.trim();
      const taskId = process.env.SLASK_RALPH_TASK ? process.env.SLASK_RALPH_TASK : undefined;
      await appendProgress(base, run, `\n- ${taskId ? `[${taskId}] ` : ""}${note}`);

      // Keep an additional structured, queryable memory for later iterations.
      const kb = await readKnowledgeBase(base, run);
      const parsed = parseKnowledgeFromNote(note);
      const key = `note:${parsed.category}:${sha256Hex(note).slice(0, 16)}`;
      kb.entries[key] = {
        key,
        value: parsed.value,
        category: parsed.category,
        updatedAt: new Date().toISOString(),
        taskOrigin: taskId,
      };
      await saveKnowledgeBase(base, run, kb);
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
      try {
        const ids = await splitTask(base, run, id, Array.isArray(args.tasks) ? (args.tasks as NewTask[]) : []);
        await writeSplitResult(runDir(base, run), { taskId: id, ok: true, ids });
        return text(`${id} replaced by ${ids.join(", ")} — the loop will work on them next; stop now.`);
      } catch (e) {
        await writeSplitResult(runDir(base, run), { taskId: id, ok: false, error: e instanceof Error ? e.message : String(e) });
        throw e;
      }
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

// ---------------------------------------------------------------------------
// the splitter's sandbox: it may only look at the spec and prd.json, in small slices
// ---------------------------------------------------------------------------

export const SPLIT_READ_BYTES = 8000;
const SPLITTER_TOOLS = ["read_file", "grep_file", "ralph_status", "ralph_split_task"];
const REQUIRED_TOOLS: Partial<Record<Role, string[]>> = {
  splitter: ["ralph_split_task"],
  checker: ["ralph_verdict"],
};

/** Tool(s) a role's turn must end with (see AgentTurnConfig.requireTool); undefined = none. */
export function requiredToolsForRole(): string[] | undefined {
  return REQUIRED_TOOLS[ralphRole()];
}

/** Does this role get to use tool `name` at all? (Only the splitter is restricted.) */
export function roleMayCall(name: string): boolean {
  return ralphRole() !== "splitter" || SPLITTER_TOOLS.includes(name);
}

/** Drop every tool the current role may not use (splitter: only reading its two files + split). */
export function restrictToolsForRole(tools: OpenAiFunctionTool[]): OpenAiFunctionTool[] {
  return ralphRole() === "splitter" ? tools.filter((t) => SPLITTER_TOOLS.includes(t.function.name)) : tools;
}

/**
 * Guard for the file tools. For the splitter: read_file/grep_file only, only on the run's
 * spec.md and prd.json (never findings/reports/logs), and each read is capped at
 * SPLIT_READ_BYTES. Returns the (possibly adjusted) args; throws a model-actionable
 * error otherwise. A no-op for every other role.
 */
export function guardFileCall(base: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (ralphRole() !== "splitter") return args;
  if (name !== "read_file" && name !== "grep_file") {
    throw new Error(`${name} is not available to the splitter — it may only read the spec and prd.json`);
  }
  const dir = process.env.SLASK_RALPH_DIR ?? "";
  const target = resolve(base, String(args.path ?? ""));
  const allowed = [join(dir, SPEC_FILE), join(dir, "prd.json")].map((p) => resolve(p));
  if (!allowed.includes(target)) {
    const rel = allowed.map((p) => relative(base, p));
    throw new Error(
      `the splitter may only read ${rel.join(" and ")} (use grep_file or a small read_file slice); ` +
        "findings, reports and other files are off limits and not needed to split a task",
    );
  }
  if (name === "read_file") {
    const asked = Number(args.bytes);
    const bytes = Number.isInteger(asked) && asked > 0 ? Math.min(asked, SPLIT_READ_BYTES) : SPLIT_READ_BYTES;
    return { ...args, bytes };
  }
  return args;
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
  "  /ralph reopen <name> <task-id>                   re-run a task that already passed (then /ralph start)",
  "  /ralph report <name>                             research: rewrite report.md from the findings (all tasks must pass)",
  "  /ralph split <name> <task-id>                    replace a too-big task with 2-4 smaller ones (model-assisted)",
  "  /ralph start <name>                              run the loop in the background",
  "  /ralph stop <name>                               stop a running loop",
  "",
  "Model selection: the REPL takes positional args only. Pick a models.json " +
  "entry from the shell CLI (e.g. slask-client ralph run <name> " +
  "--worker-model fast --report-model smart) or via the schedule / MCP tools.",
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
  | { kind: "reopen"; name: string; id: string }
  | { kind: "report"; name: string }
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
    case "reopen": {
      if (name === undefined || parts[3] === undefined || parts.length > 4) {
        return { kind: "error", message: "usage: /ralph reopen <name> <task-id> (e.g. /ralph reopen local-llm T2.1)" };
      }
      return { kind: "reopen", name, id: parts[3] };
    }
    case "report":
      return need("/ralph report <name>") ?? { kind: "report", name };
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
      case "reopen": {
        const t = await reopenTask(base, p.name, p.id);
        return { text: `re-opened ${t.id}: ${t.title} — /ralph start ${p.name} runs it again` };
      }
      case "report":
        return { text: (await runReport({ base, name: p.name, runAgentFn: agentFn, log: () => {} })).text };
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
  desc?: string;
  note?: string;
  /** models.json selection (`provider/id`) for the top-level / role-default model (`--model`). */
  model?: string | null;
  /** The `--base-url` session override. */
  base?: string | null;
  /** models.json selection (`provider/id`) for the worker role (`--worker-model`). Omitted = model. */
  workerModel?: string | null;
  /** models.json selection (`provider/id`) for the checker role (`--checker-model`). Omitted = model. */
  checkerModel?: string | null;
  /** models.json selection (`provider/id`) for the splitter role (`--splitter-model`). Omitted = model. */
  splitterModel?: string | null;
  /** models.json selection (`provider/id`) for the report role (`--report-model`). Omitted = model. */
  reportModel?: string | null;
}

const CLI_USAGE =
  "usage: slask-client ralph <init|add|run|start|stop|status|list> [name] — " +
  "init <name> [--mode code|research] [--check <cmd>] [--from prd.json] [--spec <file> [--plan]] [--out <dir>] [--context <tokens>] [--tool-budget <n>]; spec <name> <file>; split <name> <task-id> [--splitter-model <provider/id>]; add <name> <title> [--criteria \"a;b\"] [--desc <text>]; reopen <name> <task-id> [--note <why>]; report <name> [--report-model <provider/id>]; " +
  "run <name> [--max N] [--model <provider/id>] [--worker-model <provider/id>] [--checker-model <provider/id>] [--splitter-model <provider/id>] [--report-model <provider/id>]; start|stop <name>; status [name]; list " +
  "(--model and role flags take models.json selections (provider/id, or a bare id if unique); unknown selections fail with the available provider/id list)";

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
  return runCliChild(
    [
      "--prompt",
      a.prompt,
      "--quiet",
      ...forwardArgs,
      ...(a.modelId ? ["--model", a.modelId] : []),
    ],
    {
      timeoutMs: a.timeoutMs,
      env: a.env,
      capture: true,
      onOutput: (c) => void appendFile(a.logFile, c).catch(() => {}),
    },
  );
};

export interface SplitOutcome {
  /** True only if the task is gone AND at least two replacement tasks exist. */
  ok: boolean;
  /** Ids of the replacement tasks (empty on failure). */
  ids: string[];
  /** Exit code of the splitter child. */
  code: number;
  /** Why it failed (empty on success). */
  reason: string;
  /** Human-readable one-liner (+ task list on success). */
  text: string;
}

/**
 * Have a splitter child replace task `id` with 2-4 smaller tasks (shared by
 * `slask-client ralph split`, `/ralph split` and the loop's automatic split).
 * Success is judged from the resulting task list, not from the child's exit code or
 * text; on failure the reason is the splitter's own rejection (e.g. "too coarse …"),
 * else its exit/last output, and is recorded in progress.txt.
 */
export async function splitViaAgent(
  base: string,
  name: string,
  id: string,
  agentFn: (a: AgentRunArgs) => Promise<ExecResult> = defaultAgentFn,
  why?: string,
  model?: ResolvedModel,
): Promise<SplitOutcome> {
  const prd = await loadPrd(base, name);
  const task = prd.tasks.find((x) => x.id === id);
  if (task === undefined) throw new Error(`no task ${id} in run "${name}"`);
  if (task.passes) throw new Error(`${id} already passes — nothing to split`);
  if (id.split(".").length - 1 >= MAX_SPLIT_DEPTH) {
    throw new Error(`${id} was already split ${MAX_SPLIT_DEPTH} times — it cannot be split further`);
  }
  const cfg = await loadConfig(base, name);
  const dir = runDir(base, name);
  await writeFile(join(dir, "split-result.json"), "").catch(() => {});
  // The splitter role's model (threaded by the caller, else the file default).
  const m = model ?? (await resolveModel(base, { baseOverride: null }));
  const prompt = splitterPrompt(
    prd, cfg, task, relative(base, dir), outputDirOf(name, cfg), (await specSize(base, name)) !== null,
    why ?? task.lastFailure ?? "manual split requested",
    m.contextWindow,
  );
  const env = ralphChildEnv(dir, name, cfg, "splitter", id, m.contextWindow);
  const logFile = join(dir, "iterations", `split-${id}.log`);
  const r = await agentFn({ prompt, env, timeoutMs: cfg.timeoutS * 1000, logFile, modelId: m.selection });

  const after = await loadPrd(base, name);
  const ids = after.tasks.filter((t) => t.id.startsWith(`${id}.`) && !t.id.slice(id.length + 1).includes(".")).map((t) => t.id);
  const gone = !after.tasks.some((t) => t.id === id);
  const ok = gone && ids.length >= 2;
  if (ok) {
    return { ok, ids, code: r.code, reason: "", text: `✓ split ${id} into ${ids.join(", ")}:\n${await formatStatus(base, name)}` };
  }
  const res = await readSplitResult(dir);
  const reason =
    res && res.ok === false && res.error
      ? `ralph_split_task was rejected: ${res.error}`
      : gone
        ? "the task was removed but fewer than 2 replacement tasks exist"
        : r.code !== 0
          ? `the splitter exited with code ${r.code}${lastLine(r.output) ? `: ${lastLine(r.output)}` : ""}`
          : "the splitter never called ralph_split_task successfully";
  await appendProgress(base, name, `\n## ${new Date().toISOString()} — ${id} ${task.title}: SPLIT FAILED\n${reason}`);
  return {
    ok: false,
    ids: [],
    code: r.code,
    reason,
    text: `✗ could not split ${id}: ${reason}\n  log: ${STATE_DIR}/${name}/iterations/split-${id}.log`,
  };
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
        const topModel = await resolveModel(base, { selection: a.model ?? null, baseOverride: a.base ?? null });
        const prompt = planPrompt(prd, spec !== undefined, false, relative(base, runDir(base, name)), await loadConfig(base, name), topModel.contextWindow);
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
        description: a.desc,
        acceptanceCriteria: a.criteria ? a.criteria.split(";").map((s) => s.trim()).filter(Boolean) : [],
      });
      log(`added ${t.id}: ${t.title}`);
      for (const p of lintTask((await loadPrd(base, name)).mode, t)) log(`⚠ ${t.id}: ${p}`);
      return 0;
    }
    case "reopen": {
      const id = a.positional[3];
      if (name === undefined || id === undefined) throw new Error(CLI_USAGE);
      const t = await reopenTask(base, name, id, a.note);
      log(`re-opened ${t.id}: ${t.title} — \`ralph start ${name}\` runs it again${(await loadPrd(base, name)).mode === "research" ? " and rewrites the report" : ""}`);
      return 0;
    }
    case "report": {
      if (name === undefined) throw new Error(CLI_USAGE);
      const r = await runReport({
        base,
        name,
        runAgentFn: deps.agentFn,
        log,
        reportModelId: a.reportModel ?? a.model ?? null,
        baseOverride: a.base ?? null,
      });
      log(r.text);
      return r.ok ? 0 : 1;
    }
    case "split": {
      const id = a.positional[3];
      if (name === undefined || id === undefined) throw new Error(CLI_USAGE);
      const splitterModel = await resolveModel(base, { selection: a.splitterModel ?? a.model ?? null, baseOverride: a.base ?? null });
      const r = await splitViaAgent(base, name, id, deps.agentFn, undefined, splitterModel);
      log(r.text);
      return r.ok ? 0 : 1;
    }
    case "run": {
      if (name === undefined) throw new Error(CLI_USAGE);
      const out = await runRalph({
        base,
        name,
        maxIterations: a.max ? Number.parseInt(a.max, 10) : undefined,
        baseOverride: a.base ?? null,
        modelId: a.model ?? null,
        workerModelId: a.workerModel ?? a.model ?? null,
        checkerModelId: a.checkerModel ?? a.model ?? null,
        splitterModelId: a.splitterModel ?? a.model ?? null,
        reportModelId: a.reportModel ?? a.model ?? null,
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
