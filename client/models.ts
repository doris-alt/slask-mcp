// models.ts — provider-based multi-model support for the client.
//
// The client can point at **many** OpenAI-compatible models. The catalog lives in
// `models.json` in the launch cwd (same convention as `.env` / `mcp.json`), shaped:
//
//   {
//     "models": {
//       "providers": {
//         "custom-proxy": {
//           "baseUrl": "http://localhost:4000/v1",
//           "apiKey": "LITELLM_KEY",
//           "models": [
//             {
//               "id": "llama-3.1-8b",
//               "name": "Llama 3.1 8B",
//               "api": "openai-completions",
//               "reasoning": false,
//               "input": ["text"],
//               "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
//               "contextWindow": 128000,
//               "maxTokens": 32000
//             }
//           ]
//         }
//       }
//     }
//   }
//
// The **provider** groups models that share an endpoint: `baseUrl` (endpoint root,
// optional per provider) and `apiKey` (optional; keys normally come from the env
// and are *not* written into the auto-seed file).
//
// Each **model** under `providers.<name>.models` carries:
//   * `id`          selection key — non-empty and unique *within* its provider.
//   * `name`        the name sent to the API `model:` field on every request.
//   * `contextWindow` optional — context window in tokens (integer ≥ 2000).
//                     Drives Ralph sizing (`limitsOf`).
//   * `maxTokens`   optional — output-capability ceiling for the raw agent loop
//                     (integer ≥ 1). Applied in `runAgentTurn`; a valid
//                     `SLASK_MAX_TOKENS` env knob (user or Ralph) still wins,
//                     clamped to this capability.
//   * `api` / `reasoning` / `input[]` / `cost{...}` — inert metadata: type-checked
//     and stored for the future, not yet acted on. Unknown extra fields are
//     ignored (lenient, matching the old validation).
//
// Selection (single point — `resolveModel`) is `provider/id`
// (e.g. `custom-proxy/llama-3.1-8b`). A **bare** `id` is accepted when it is
// unique across *all* providers; if it matches more than one provider the
// selection is **ambiguous** and an error lists every match. With no selection
// the **first** provider's **first** model is used (file/JSON insertion order).
//
// Base precedence: provider `baseUrl` > `--base-url` (session override) >
//   `API_BASE` > `DEFAULT_API_BASE`; the result is normalized by `ensureV1Path`.
// Key precedence: provider `apiKey` > `OPENAI_API_KEY` > the `"local"`
//   placeholder (real OpenAI still requires a key → error).
//
// Environment vars remain the *seed*: on first run, if `models.json` is missing
// it is auto-created from the env (a one-model catalog, provider `default`) and
// persisted. `MODEL`/`OPENAI_MODEL` seed the `id`/`name`; `API_BASE` and
// `MAX_CONTEXT_TOKENS` seed the base and context window. They never replace an
// existing file — the file wins once it exists. Note the seed never writes `apiKey`.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  envContextTokens,
  ensureV1Path,
} from "./agent.js";

// ---------------------------------------------------------------------------
// Catalog shape
// ---------------------------------------------------------------------------

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

interface ModelEntry {
  /** Selection key. Non-empty and unique within its provider. */
  id: string;
  /** Name sent to the API `model:` field on every request. Non-empty. */
  name: string;
  /** Optional context window in tokens (integer ≥ 2000). Drives Ralph sizing. */
  contextWindow?: number;
  /** Optional output-capability ceiling for the raw agent loop (integer ≥ 1). */
  maxTokens?: number;
  /** Inert metadata. */
  api?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelCost;
}

interface ProviderDef {
  /** Optional endpoint root (endpoint root; `/v1` appended by `ensureV1Path`). */
  baseUrl?: string;
  /** Optional API key. Wins over the `OPENAI_API_KEY` env; keys usually stay in env. */
  apiKey?: string;
  models: ModelEntry[];
}

export interface ModelFile {
  models: { providers: Record<string, ProviderDef> };
}

export interface ResolvedModel {
  /** Provider name the selected model lives under. */
  providerId: string;
  /** The selected `id` (unique within its provider). */
  id: string;
  /** The name sent to the API. */
  name: string;
  /** `provider/id` — what is forwarded to child CLI runs so they pick the same model. */
  selection: string;
  /** The normalized base URL (endpoint root; `/v1` guaranteed via ensureV1Path). */
  baseUrl: string;
  /** The provider's raw `apiKey`, or null (caller falls back to env / "local"). */
  apiKey: string | null;
  /** Raw entry context window (undefined if unset — Ralph folds env/default). */
  contextWindow?: number;
  /** Raw entry output cap (undefined if unset — runAgentTurn folds the env knob). */
  maxTokens?: number;
}

export interface ResolveModelOpts {
  /**
   * The model to select: `provider/id` (required provider part), or a bare `id`
   * accepted only when it is unique across all providers. When null/omitted the
   * first provider's first model is chosen. A bad selection throws, listing the
   * available `provider/id` entries.
   */
  selection?: string | null;
  /**
   * Session base override (`--base-url`). Only used when the selected provider
   * has no `baseUrl` of its own — the provider's base is authoritative.
   */
  baseOverride?: string | null;
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

function validateCost(providerName: string, id: string, raw: unknown): ModelCost {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `models.json: provider "${providerName}" model "${id}" "cost" must be an object`,
    );
  }
  const o = raw as Record<string, unknown>;
  const cost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const fields: Array<[keyof ModelCost, string]> = [
    ["input", "input"],
    ["output", "output"],
    ["cacheRead", "cacheRead"],
    ["cacheWrite", "cacheWrite"],
  ];
  for (const [key, label] of fields) {
    if (o[label] !== undefined) {
      const n = Number(o[label]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(
          `models.json: provider "${providerName}" model "${id}" "cost.${label}" must be ` +
            `a non-negative number, got ${JSON.stringify(o[label])}`,
        );
      }
      cost[key] = n;
    }
  }
  return cost;
}

function validateModel(
  providerName: string,
  raw: unknown,
  i: number,
  seen: Set<string>,
): ModelEntry {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `models.json: provider "${providerName}" model #${i} must be an object`,
    );
  }
  const o = raw as Record<string, unknown>;
  const id = String(o.id ?? "").trim();
  const name = String(o.name ?? "").trim();
  if (id === "") {
    throw new Error(
      `models.json: provider "${providerName}" model #${i} is missing a non-empty "id"`,
    );
  }
  if (name === "") {
    throw new Error(
      `models.json: provider "${providerName}" model #${i} (id="${id}") is missing a non-empty "name"`,
    );
  }
  if (seen.has(id)) {
    throw new Error(
      `models.json: provider "${providerName}" has duplicate id "${id}" — ids must be ` +
        `unique within a provider`,
    );
  }
  seen.add(id);
  const entry: ModelEntry = { id, name };
  if (o.contextWindow !== undefined) {
    const n = Number(o.contextWindow);
    if (!Number.isInteger(n) || n < 2000) {
      throw new Error(
        `models.json: provider "${providerName}" model "${id}" has invalid ` +
          `"contextWindow" ${JSON.stringify(o.contextWindow)} (must be an integer ≥ 2000)`,
      );
    }
    entry.contextWindow = n;
  }
  if (o.maxTokens !== undefined) {
    const n = Number(o.maxTokens);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(
        `models.json: provider "${providerName}" model "${id}" has invalid ` +
          `"maxTokens" ${JSON.stringify(o.maxTokens)} (must be an integer ≥ 1)`,
      );
    }
    entry.maxTokens = n;
  }
  // Inert metadata: validated when present, ignored otherwise.
  if (o.api !== undefined && typeof o.api !== "string") {
    throw new Error(
      `models.json: provider "${providerName}" model "${id}" "api" must be a string`,
    );
  }
  if (o.reasoning !== undefined && typeof o.reasoning !== "boolean") {
    throw new Error(
      `models.json: provider "${providerName}" model "${id}" "reasoning" must be a boolean`,
    );
  }
  if (o.input !== undefined) {
    if (!Array.isArray(o.input) || o.input.some((v) => typeof v !== "string")) {
      throw new Error(
        `models.json: provider "${providerName}" model "${id}" "input" must be an array of strings`,
      );
    }
    entry.input = o.input;
  }
  if (o.cost !== undefined) {
    entry.cost = validateCost(providerName, id, o.cost);
  }
  return entry;
}

function validateProvider(name: string, p: unknown): ProviderDef {
  if (!p || typeof p !== "object" || Array.isArray(p)) {
    throw new Error(`models.json: provider "${name}" must be an object`);
  }
  const o = p as Record<string, unknown>;
  const provider: ProviderDef = { models: [] };
  if (o.baseUrl !== undefined) {
    const b = String(o.baseUrl).trim();
    if (b === "") {
      throw new Error(`models.json: provider "${name}" has an empty "baseUrl"`);
    }
    provider.baseUrl = b;
  }
  if (o.apiKey !== undefined) {
    const k = String(o.apiKey).trim();
    if (k === "") {
      throw new Error(`models.json: provider "${name}" has an empty "apiKey"`);
    }
    provider.apiKey = k;
  }
  const modelsRaw = o.models;
  if (!modelsRaw || !Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    throw new Error(
      `models.json: provider "${name}" must have a non-empty "models" array`,
    );
  }
  const seen = new Set<string>();
  for (let i = 0; i < modelsRaw.length; i++) {
    provider.models.push(validateModel(name, modelsRaw[i], i, seen));
  }
  return provider;
}

/**
 * Read `<cwd>/models.json`. Returns the parsed catalog when the file is valid;
 * `null` when it is simply missing; a descriptive `Error` when it exists but is
 * malformed JSON or has the wrong shape.
 */
export async function loadModelsFile(cwd: string): Promise<ModelFile | null> {
  const raw = await readFileOrNull(modelsFileFor(cwd));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${MODELS_FILE_NAME} in ${cwd} is not valid JSON — fix or delete it`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `${MODELS_FILE_NAME} in ${cwd} must be a JSON object with a "models" key`,
    );
  }
  const top = parsed as { models?: unknown };
  if (!top.models || typeof top.models !== "object" || Array.isArray(top.models)) {
    throw new Error(
      `${MODELS_FILE_NAME} in ${cwd} must be a JSON object with a "models" key`,
    );
  }
  const models = top.models as { providers?: unknown };
  if (
    !models.providers ||
    typeof models.providers !== "object" ||
    Array.isArray(models.providers)
  ) {
    throw new Error(
      `${MODELS_FILE_NAME} in ${cwd} must have a "models.providers" object`,
    );
  }
  const providersRaw = models.providers as Record<string, unknown>;
  const providers: Record<string, ProviderDef> = {};
  for (const [name, p] of Object.entries(providersRaw)) {
    providers[name] = validateProvider(name, p);
  }
  if (Object.keys(providers).length === 0) {
    throw new Error(
      `${MODELS_FILE_NAME} in ${cwd} has no providers — add at least one`,
    );
  }
  return { models: { providers } };
}

/** Persist a catalog atomically to `<cwd>/models.json`. */
export async function saveModelsFile(cwd: string, file: ModelFile): Promise<void> {
  await atomicWrite(modelsFileFor(cwd), JSON.stringify(file, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Environment seed
// ---------------------------------------------------------------------------

/**
 * A one-provider/one-model catalog built from the environment — what `models.json`
 * is bootstrapped from when the file does not yet exist. `MODEL`/`OPENAI_MODEL`
 * seed the model `id`/`name`; `API_BASE` (if set) and `MAX_CONTEXT_TOKENS` seed the
 * provider base and the model's context window. The auto-seed **never writes an
 * `apiKey`** — keys stay in the env (`.env`) and are added to a provider manually.
 */
function modelsFromEnv(): ModelFile {
  const name =
    process.env.MODEL?.trim() || process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const baseUrl = process.env.API_BASE?.trim() || undefined;
  const ctx = envContextTokens();
  const models: ModelEntry[] = [
    {
      id: name,
      name,
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
    },
  ];
  const provider: ProviderDef = { models };
  if (baseUrl) provider.baseUrl = baseUrl;
  return { models: { providers: { default: provider } } };
}

/**
 * Load `models.json` from `cwd`; when it is missing, auto-create it from the
 * environment (via `modelsFromEnv()`), persist it, and return the resulting
 * catalog. Idempotent: an existing valid file is returned unchanged.
 */
export async function ensureModelsFile(cwd: string): Promise<ModelFile> {
  const existing = await loadModelsFile(cwd);
  if (existing !== null) {
    return existing;
  }
  const seeded = modelsFromEnv();
  await saveModelsFile(cwd, seeded);
  return seeded;
}

// ---------------------------------------------------------------------------
// Resolution — the single selection point used by chat, Ralph, and schedule
// ---------------------------------------------------------------------------

function finishResolve(
  pid: string,
  provider: ProviderDef,
  entry: ModelEntry,
  opts: ResolveModelOpts,
): ResolvedModel {
  const baseUrl = ensureV1Path(
    (provider.baseUrl ?? (opts.baseOverride ?? process.env.API_BASE ?? DEFAULT_API_BASE) ?? DEFAULT_API_BASE).trim(),
  );
  return {
    providerId: pid,
    id: entry.id,
    name: entry.name,
    selection: `${pid}/${entry.id}`,
    baseUrl,
    apiKey: provider.apiKey ?? null,
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
}

export async function resolveModel(
  cwd: string,
  opts: ResolveModelOpts = {},
): Promise<ResolvedModel> {
  const { providers } = (await ensureModelsFile(cwd)).models;
  const available = Object.entries(providers).flatMap(([pid, def]) =>
    def.models.map((e) => `${pid}/${e.id}`),
  );
  if (available.length === 0) {
    throw new Error("models.json has no models — add a provider with at least one model");
  }

  const raw = opts.selection ? String(opts.selection).trim() : null;

  if (raw === null) {
    // No selection: first provider, first model (JSON insertion order).
    const [pid, provider] = Object.entries(providers)[0]!;
    return finishResolve(pid, provider, provider.models[0]!, opts);
  }

  const slash = raw.indexOf("/");
  if (slash > 0) {
    // provider/id
    const pid = raw.slice(0, slash);
    const mid = raw.slice(slash + 1);
    const provider = providers[pid];
    if (!provider) {
      throw new Error(
        `unknown provider "${pid}" in ${cwd}/${MODELS_FILE_NAME} ` +
          `(available: ${available.join(", ")})`,
      );
    }
    const entry = provider.models.find((e) => e.id === mid);
    if (!entry) {
      throw new Error(
        `unknown model "${mid}" in provider "${pid}" ` +
          `(provider models: ${provider.models.map((e) => e.id).join(", ")}; all: ${available.join(", ")})`,
      );
    }
    return finishResolve(pid, provider, entry, opts);
  }

  // Bare id: only valid when it is unique across all providers.
  const matches: Array<{ pid: string; provider: ProviderDef; entry: ModelEntry }> = [];
  for (const [p, def] of Object.entries(providers)) {
    const m = def.models.find((e) => e.id === raw);
    if (m) matches.push({ pid: p, provider: def, entry: m });
  }
  if (matches.length === 0) {
    throw new Error(
      `unknown model "${raw}" in ${cwd}/${MODELS_FILE_NAME} ` +
        `(available: ${available.join(", ")})`,
    );
  }
  if (matches.length > 1) {
    const all = matches.map((m) => `${m.pid}/${m.entry.id}`);
    throw new Error(
      `model "${raw}" is ambiguous — it exists in multiple providers ` +
        `(matches: ${all.join(", ")}). Use a provider/id selection instead.`,
    );
  }
  const { pid, provider, entry } = matches[0];
  return finishResolve(pid, provider, entry, opts);
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
