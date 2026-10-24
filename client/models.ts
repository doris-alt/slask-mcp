// models.ts — multi-model support for the client.
//
// The client can point at **many** OpenAI-compatible models. The catalog lives in
// `models.json` in the launch cwd (same convention as `.env` / `mcp.json`), shaped
// like:
//
//   {
//     "models": [
//       { "id": "fast",  "name": "gpt-4o-mini",  "maxContext": 32000,  "default": true },
//       { "id": "smart", "name": "gpt-4o", "baseUrl": "http://host:11434/v1",
//         "maxContext": 131072 }
//     ]
//   }
//
// - `id`       the selection key (used by `--model`, Ralph role flags, `schedule add --model`).
// - `name`     the name sent to the API on every request.
// - `baseUrl`  optional — that model's endpoint root; authoritative when present.
// - `maxContext` optional — the model's context window in tokens (integer ≥ 2000).
// - `default`  optional — marks which entry is the fallback when no `id` is selected.
//
// Resolution (single point — `resolveModel`):
//   * `models.json` in the cwd is the source of truth. When it is missing it is
//     **auto-created** from the environment (a one-entry catalog) and persisted.
//   * An entry's `baseUrl` beats `--base-url` (session override) beats `API_BASE`
//     beats `DEFAULT_API_BASE`. An entry's `maxContext` beats `MAX_CONTEXT_TOKENS`
//     beats `DEFAULT_CONTEXT_TOKENS`.
//
// Environment variables remain the *seed/fallback*: `MODEL`/`OPENAI_MODEL` seed the
// bootstrap entry's `id`/`name`; `API_BASE`/`MAX_CONTEXT_TOKENS` seed its base and
// context window. They never replace the file — the file wins once it exists.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_API_BASE,
  DEFAULT_CONTEXT_TOKENS,
  DEFAULT_MODEL,
  envContextTokens,
  ensureV1Path,
} from "./agent.js";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

export interface ModelEntry {
  /** Selection key. Non-empty and unique within the file. */
  id: string;
  /** Name sent to the API on every request. Non-empty. */
  name: string;
  /** Optional endpoint root for this model. Authoritative when present. */
  baseUrl?: string;
  /** Optional context window in tokens (integer ≥ 2000). */
  maxContext?: number;
  /** Optional: the fallback entry when no `id` is selected. */
  default?: boolean;
}

interface ModelsFile {
  models: ModelEntry[];
}

const MODELS_FILE_NAME = "models.json";

// ---------------------------------------------------------------------------
// Load / save (mirrors `schedule.ts` storage)
// ---------------------------------------------------------------------------

function modelsFileFor(cwd: string): string {
  return join(cwd, MODELS_FILE_NAME);
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

/**
 * Validate (and normalize) a single `models.json` entry. Throws on malformed
 * shape so a bad file fails at load time with a clear, actionable message.
 */
function validateEntry(e: unknown, i: number): ModelEntry {
  if (!e || typeof e !== "object" || Array.isArray(e)) {
    throw new Error(`models.json: entry #${i} must be an object`);
  }
  const o = e as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  const name = String(o.name ?? "").trim();
  if (id === "") {
    throw new Error(`models.json: entry #${i} is missing a non-empty "id"`);
  }
  if (name === "") {
    throw new Error(`models.json: entry #${i} (id="${id}") is missing a non-empty "name"`);
  }
  const entry: ModelEntry = { id, name };
  if (o.baseUrl !== undefined) {
    const b = String(o.baseUrl).trim();
    if (b === "") {
      throw new Error(`models.json: entry "${id}" has an empty "baseUrl"`);
    }
    entry.baseUrl = b;
  }
  if (o.maxContext !== undefined) {
    const n = Number(o.maxContext);
    if (!Number.isInteger(n) || n < 2000) {
      throw new Error(
        `models.json: entry "${id}" has an invalid "maxContext" ${JSON.stringify(
          o.maxContext,
        )} (must be an integer ≥ 2000)`,
      );
    }
    entry.maxContext = n;
  }
  if (o.default !== undefined) {
    if (typeof o.default !== "boolean") {
      throw new Error(`models.json: entry "${id}" "default" must be a boolean`);
    }
    entry.default = o.default;
  }
  return entry;
}

/**
 * Read `<cwd>/models.json`. Returns the entry list when the file is valid;
 * `null` when it is simply missing; a descriptive `Error` when it exists but
 * is malformed JSON or has the wrong shape.
 */
export async function loadModelsFile(
  cwd: string,
): Promise<ModelEntry[] | null> {
  const raw = await readFileOrNull(modelsFileFor(cwd));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MODELS_FILE_NAME} in ${cwd} is not valid JSON — fix or delete it`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("models" in parsed) ||
    !Array.isArray((parsed as ModelsFile).models)
  ) {
    throw new Error(
      `${MODELS_FILE_NAME} in ${cwd} must be JSON with a "models" array — fix or delete it`,
    );
  }
  const entries = (parsed as ModelsFile).models.map((e, i) => validateEntry(e, i));
  // ids must be unique — selection is by id.
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) {
      throw new Error(`models.json: duplicate id "${e.id}" — ids must be unique`);
    }
    seen.add(e.id);
  }
  return entries;
}

/** Persist a catalog atomically to `<cwd>/models.json`. */
export async function saveModelsFile(cwd: string, entries: ModelEntry[]): Promise<void> {
  await atomicWrite(modelsFileFor(cwd), JSON.stringify({ models: entries }, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Environment seed
// ---------------------------------------------------------------------------

/**
 * A one-entry catalog built from environment variables — what `models.json` is
 * bootstrapped from when the file does not yet exist. `MODEL`/`OPENAI_MODEL`
 * seed the `id`/`name`; `API_BASE` and `MAX_CONTEXT_TOKENS` are optional.
 */
function modelsFromEnv(): ModelEntry {
  const name = process.env.MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const entry: ModelEntry = { id: name, name, default: true };
  const apiBase = process.env.API_BASE?.trim();
  if (apiBase) entry.baseUrl = apiBase;
  const ctx = envContextTokens();
  if (ctx !== undefined) entry.maxContext = ctx;
  return entry;
}

/**
 * Load `models.json` from `cwd`; when it is missing, auto-create it from the
 * environment (via `modelsFromEnv()`), persist it, and return the resulting
 * catalog. Idempotent: an existing valid file is returned unchanged.
 */
export async function ensureModelsFile(cwd: string): Promise<ModelEntry[]> {
  const existing = await loadModelsFile(cwd);
  if (existing !== null) {
    return existing;
  }
  const seeded = [modelsFromEnv()];
  await saveModelsFile(cwd, seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// Resolution — the single selection point used by chat, Ralph, and schedule
// ---------------------------------------------------------------------------

export interface ResolvedModel {
  /** The selected `id` (re-passed to child CLI runs so they pick the same entry). */
  id: string;
  /** The name sent to the API. */
  name: string;
  /** The normalized base URL (endpoint root; `/v1` guaranteed via ensureV1Path). */
  baseUrl: string;
  /** Effective context window in tokens. */
  maxContext: number;
}

export interface ResolveModelOpts {
  /**
   * The `id` to select. When omitted/null, the entry with `default: true` is
   * chosen (else the first entry). A non-empty id that is not in the file
   * throws listing the available ids.
   */
  id?: string | null;
  /**
   * Session base override (`--base-url`). Only used when the selected entry has
   * no `baseUrl` of its own — the entry's base is authoritative.
   */
  baseOverride?: string | null;
}

export async function resolveModel(
  cwd: string,
  opts: ResolveModelOpts = {},
): Promise<ResolvedModel> {
  const entries = await ensureModelsFile(cwd);
  if (entries.length === 0) {
    // ensureModelsFile always seeds at least one entry, but guard anyway.
    throw new Error("models.json has no entries — add at least one model");
  }

  const selectedId = opts.id ? String(opts.id).trim() : null;
  let entry: ModelEntry;
  if (selectedId !== null) {
    const m = entries.find((e) => e.id === selectedId);
    if (m === undefined) {
      throw new Error(
        `unknown model id "${selectedId}" in ${cwd}/models.json ` +
          `(available ids: ${entries.map((e) => e.id).join(", ")})`,
      );
    }
    entry = m;
  } else {
    entry = entries.find((e) => e.default === true) ?? entries[0];
  }

  const baseUrl = ensureV1Path(
    entry.baseUrl ??
      (opts.baseOverride ?? process.env.API_BASE ?? DEFAULT_API_BASE)
      .trim(),
  );
  const maxContext = entry.maxContext ?? envContextTokens() ?? DEFAULT_CONTEXT_TOKENS;

  return {
    id: entry.id,
    name: entry.name,
    baseUrl,
    maxContext,
  };
}

// ---------------------------------------------------------------------------
// Small argv helper
// ---------------------------------------------------------------------------

/**
 * The value of a `--name <value>` (or `--name=value`) pair in an argv-like
 * array, with the *last* occurrence winning — matching the hand-rolled CLI
 * parser's last-value-wins rule. Returns the value, or null if the flag is
 * absent (or present but with no usable value, e.g. the next element is a flag).
 */
export function flagValue(args: string[], name: string): string | null {
  let last: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) last = v;
    } else if (a.startsWith(name + "=")) {
      const v = a.slice(name.length + 1);
      if (v !== "") last = v;
    }
  }
  return last;
}
