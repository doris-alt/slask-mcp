// models-test.ts — drive the provider-based model catalog (models.ts)
// in-process, fully network-free.
//
// No live model endpoint. The catalog is pure file + env plumbing, so every
// test uses a fresh empty cwd and exercises load/save/seed/resolve + the argv
// `flagValue` helper.
//
// Covers:
//   * loadModelsFile: missing -> null; malformed JSON -> "not valid JSON";
//     missing `models`/`models.providers` -> shape errors; provider-level
//     shape errors (not object, empty `models` array).
//   * saveModelsFile / round-trip.
//   * provider/model validation: empty baseUrl/apiKey, missing/empty id,
//     missing/empty name, invalid contextWindow / maxTokens, duplicate id
//     within a provider, bad inert-field types (api/reasoning/input/cost).
//   * ensureModelsFile env bootstrap: MODEL/OPENAI_MODEL -> id/name; API_BASE ->
//     provider baseUrl; MAX_CONTEXT_TOKENS -> contextWindow; provider `default`;
//     idempotency; no-env -> single DEFAULT_MODEL entry; **never writes apiKey**.
//   * resolveModel: `provider/id` selection; bare `id` unique/ambiguous/unknown;
//     no-selection default (first provider's first model); base precedence
//     (provider.baseUrl > baseOverride > API_BASE > DEFAULT_API_BASE) with /v1
//     normalization; apiKey pass-through (provider value or null); raw
//     contextWindow/maxTokens threading; auto-seed from env when file absent;
//     error messages list available `provider/id` entries.
//   * flagValue: last-value-wins, --name=value, absent -> null, no-usable-value -> null.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_API_BASE,
  DEFAULT_MODEL,
  ensureV1Path,
} from "../agent.js";
import {
  flagValue,
  loadModelsFile,
  resolveModel,
  saveModelsFile,
  ensureModelsFile,
} from "../models.js";
import type { ModelFile, ResolvedModel } from "../models.js";

// ---------------------------------------------------------------------------
// Work from a fresh, empty cwd.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const workDir = join(
  tmpdir(),
  `slask-models-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

async function freshDir(name: string): Promise<string> {
  const dir = join(workDir, name);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });
  return dir;
}

async function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  const keys = Object.keys(vars);
  for (const k of keys) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k];
    }
  }
  try {
    await fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

async function expectThrow(
  fn: () => Promise<unknown>,
  substrings?: string[],
): Promise<void> {
  let err = "";
  try {
    await fn();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  assert(err !== "", "expected an error but none was thrown");
  for (const s of substrings ?? []) {
    assert(err.includes(s), `error should include "${s}": ${err}`);
  }
}

await mkdir(workDir, { recursive: true });
process.chdir(workDir);

// ---------------------------------------------------------------------------
// Test helpers for catalog files
// ---------------------------------------------------------------------------
const modelsPath = (cwd: string) => join(cwd, "models.json");

async function writeModels(cwd: string, raw: string): Promise<void> {
  await writeFile(modelsPath(cwd), raw, "utf8");
}

process.exitCode = 0;
try {
  // ---- Test 1: loadModelsFile on a missing file -> null ----------------------
  {
    const d = await freshDir("t1-missing");
    const r = await loadModelsFile(d);
    assert(r === null, `missing models.json -> null, got ${JSON.stringify(r)}`);
    console.log("PASS test1 — loadModelsFile missing file -> null");
  }

  // ---- Test 2: malformed JSON -> "not valid JSON" ---------------------------
  {
    const d = await freshDir("t2-badjson");
    await writeModels(d, "{ not json at all");
    await expectThrow(() => loadModelsFile(d), ["not valid JSON", "models.json in"]);
    console.log('PASS test2 — loadModelsFile malformed JSON -> "not valid JSON"');
  }

  // ---- Test 3: missing `models` object ---------------------------------------
  {
    const d1 = await freshDir("t3a-nomodels");
    await writeModels(d1, '{"foo": ["a"]}');
    await expectThrow(
      () => loadModelsFile(d1),
      ['must be a JSON object with a "models" key'],
    );
    const d2 = await freshDir("t3b-emptyobj");
    await writeModels(d2, "{}");
    await expectThrow(
      () => loadModelsFile(d2),
      ['must be a JSON object with a "models" key'],
    );
    const d3 = await freshDir("t3c-array");
    await writeModels(d3, "[]");
    await expectThrow(
      () => loadModelsFile(d3),
      ['must be a JSON object with a "models" key'],
    );
    console.log("PASS test3 — loadModelsFile missing/wrong `models` shape rejected");
  }

  // ---- Test 4: missing `models.providers` / empty providers -------------------
  {
    const d1 = await freshDir("t4a-noproviders");
    await writeModels(d1, '{"models": {}}');
    await expectThrow(
      () => loadModelsFile(d1),
      ['must have a "models.providers" object'],
    );
    const d2 = await freshDir("t4b-prov-array");
    await writeModels(d2, '{"models": {"providers": []}}');
    await expectThrow(
      () => loadModelsFile(d2),
      ['must have a "models.providers" object'],
    );
    const d3 = await freshDir("t4c-no-providers");
    await writeModels(d3, '{"models": {"providers": {}}}');
    await expectThrow(
      () => loadModelsFile(d3),
      ['has no providers — add at least one'],
    );
    console.log("PASS test4 — loadModelsFile missing/empty providers rejected");
  }

  // ---- Test 5: provider shape errors ------------------------------------------
  {
    const d1 = await freshDir("t5a-prov-not-object");
    await writeModels(d1, '{"models": {"providers": {"p": []}}}');
    await expectThrow(() => loadModelsFile(d1), ['provider "p" must be an object']);
    const d2 = await freshDir("t5b-empty-models");
    await writeModels(
      d2,
      '{"models": {"providers": {"p": {"models": []}}}}',
    );
    await expectThrow(() => loadModelsFile(d2), [
      'provider "p" must have a non-empty "models" array',
    ]);
    console.log("PASS test5 — provider must be object with non-empty models array");
  }

  // ---- Test 6: saveModelsFile round-trip ---------------------------------------
  {
    const d = await freshDir("t6-roundtrip");
    const file: ModelFile = {
      models: {
        providers: {
          custom: {
            baseUrl: "http://x/v1",
            apiKey: "sekret",
            models: [
              { id: "a", name: "model-a", contextWindow: 100000, maxTokens: 4096 },
              {
                id: "b",
                name: "model-b",
                api: "openai-completions",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    await saveModelsFile(d, file);
    const raw = await readFile(modelsPath(d), "utf8");
    const loaded = await loadModelsFile(d);
    assert(loaded !== null, "loaded after round-trip");
    assert(
      loaded.models.providers.custom.models[0].id === "a" &&
        loaded.models.providers.custom.models[0].name === "model-a" &&
        loaded.models.providers.custom.models[0].contextWindow === 100000 &&
        loaded.models.providers.custom.models[0].maxTokens === 4096,
      "first entry round-trips",
    );
    assert(
      loaded.models.providers.custom.models[1].name === "model-b" &&
        loaded.models.providers.custom.models[1].cost?.cacheRead === 0,
      "second entry round-trips (inert fields)",
    );
    const parsed = JSON.parse(raw);
    assert(
      parsed.models.providers.custom.apiKey === "sekret",
      "raw file keeps provider fields",
    );
    console.log("PASS test6 — saveModelsFile round-trips provider + models");
  }

  // ---- Test 7: model validation — missing id -----------------------------------
  {
    const d = await freshDir("t7-noid");
    await writeModels(
      d,
      JSON.stringify({ models: { providers: { p: { models: [{ name: "x" }] } } } }),
    );
    await expectThrow(() => loadModelsFile(d), ['missing a non-empty "id"']);
    console.log('PASS test7 — model validation: missing id rejected');
  }

  // ---- Test 8: model validation — missing name ----------------------------------
  {
    const d = await freshDir("t8-noname");
    await writeModels(
      d,
      JSON.stringify({ models: { providers: { p: { models: [{ id: "a" }] } } } }),
    );
    await expectThrow(() => loadModelsFile(d), [
      '(id="a") is missing a non-empty "name"',
    ]);
    console.log('PASS test8 — model validation: missing name rejected');
  }

  // ---- Test 9: provider validation — empty baseUrl / empty apiKey --------------
  {
    const d1 = await freshDir("t9a-emptybase");
    await writeModels(
      d1,
      JSON.stringify({
        models: { providers: { p: { baseUrl: "   ", models: [{ id: "a", name: "x" }] } } },
      }),
    );
    await expectThrow(() => loadModelsFile(d1), ['provider "p" has an empty "baseUrl"']);
    const d2 = await freshDir("t9b-emptykey");
    await writeModels(
      d2,
      JSON.stringify({
        models: { providers: { p: { apiKey: "  ", models: [{ id: "a", name: "x" }] } } },
      }),
    );
    await expectThrow(() => loadModelsFile(d2), ['provider "p" has an empty "apiKey"']);
    console.log("PASS test9 — provider validation: empty baseUrl/apiKey rejected");
  }

  // ---- Test 10: invalid contextWindow (float / sub-2000 / NaN / null) ---------
  {
    const bad = [
      { id: "a", name: "x", contextWindow: 3000.5 },
      { id: "a", name: "x", contextWindow: 1000 },
      { id: "a", name: "x", contextWindow: "abc" },
      { id: "a", name: "x", contextWindow: null },
      { id: "a", name: "x", contextWindow: 1500 },
    ];
    for (const entry of bad) {
      const dd = await freshDir("t10-case");
      await writeModels(dd, JSON.stringify({ models: { providers: { p: { models: [entry] } } } }));
      await expectThrow(() => loadModelsFile(dd), [
        'model "a" has invalid "contextWindow"',
        "(must be an integer",
      ]);
    }
    console.log(
      "PASS test10 — model validation: float/sub-2000/NaN/null contextWindow rejected",
    );
  }

  // ---- Test 11: invalid maxTokens (float / 0 / negative / NaN) ------------------
  {
    const bad = [
      { id: "a", name: "x", maxTokens: 30.5 },
      { id: "a", name: "x", maxTokens: 0 },
      { id: "a", name: "x", maxTokens: -5 },
      { id: "a", name: "x", maxTokens: "abc" },
      { id: "a", name: "x", maxTokens: null },
    ];
    for (const entry of bad) {
      const dd = await freshDir("t11-case");
      await writeModels(dd, JSON.stringify({ models: { providers: { p: { models: [entry] } } } }));
      await expectThrow(() => loadModelsFile(dd), [
        'model "a" has invalid "maxTokens"',
        "(must be an integer",
      ]);
    }
    console.log("PASS test11 — model validation: bad maxTokens rejected");
  }

  // ---- Test 12: duplicate id within a provider (across providers legal) --------
  {
    const d1 = await freshDir("t12a-dup");
    await writeModels(
      d1,
      JSON.stringify({
        models: { providers: { p: { models: [{ id: "a", name: "1" }, { id: "a", name: "2" }] } } },
      }),
    );
    await expectThrow(() => loadModelsFile(d1), [
      'provider "p" has duplicate id "a"',
      "unique within a provider",
    ]);
    const d2 = await freshDir("t12b-cross");
    await writeModels(
      d2,
      JSON.stringify({
        models: {
          providers: {
            p: { models: [{ id: "a", name: "1" }] },
            q: { models: [{ id: "a", name: "2" }] },
          },
        },
      }),
    );
    const ok = await loadModelsFile(d2);
    assert(ok !== null, `cross-provider duplicate id is legal: ${JSON.stringify(ok)}`);
    console.log("PASS test12 — duplicate id within provider rejected; across providers legal");
  }

  // ---- Test 13: inert-field type validation --------------------------------------
  {
    const bad: Record<string, unknown> = {
      api: 5,
      reasoning: "yes",
      input: ["text", 2],
      cost: { input: -1 },
    };
    for (const [field, v] of Object.entries(bad)) {
      const dd = await freshDir("t13-case");
      await writeModels(dd, JSON.stringify({
        models: { providers: { p: { models: [{ id: "a", name: "x", [field]: v }] } } },
      }));
      if (field === "cost") {
        await expectThrow(() => loadModelsFile(dd), ['"cost.input" must be a non-negative number']);
      } else if (field === "api") {
        await expectThrow(() => loadModelsFile(dd), ['"api" must be a string']);
      } else if (field === "reasoning") {
        await expectThrow(() => loadModelsFile(dd), ['"reasoning" must be a boolean']);
      } else {
        await expectThrow(() => loadModelsFile(dd), ['"input" must be an array of strings']);
      }
    }
    console.log(
      "PASS test13 — inert fields (api/reasoning/input/cost) type-validated when present",
    );
  }

  // ---- Test 14: ensureModelsFile env bootstrap — full env ------------------------
  {
    const d = await freshDir("t14-env");
    const ctx = "90000";
    await withEnv(
      {
        MODEL: "my-model",
        OPENAI_MODEL: undefined,
        API_BASE: "http://myhost:8000",
        MAX_CONTEXT_TOKENS: ctx,
        OPENAI_API_KEY: undefined,
      },
      async () => {
        const file = await ensureModelsFile(d);
        const p = file.models.providers.default;
        assert(p.models.length === 1, `one seeded model: ${p.models.length}`);
        const e = p.models[0];
        assert(e.id === "my-model" && e.name === "my-model", `id/name from MODEL: ${e.id}/${e.name}`);
        assert(p.baseUrl === "http://myhost:8000", `provider baseUrl from API_BASE: ${p.baseUrl}`);
        assert(e.contextWindow === 90000, `contextWindow from env: ${e.contextWindow}`);
        assert(p.apiKey === undefined, "auto-seed must never write apiKey");
        const raw = await readFile(modelsPath(d), "utf8");
        assert(!raw.includes('"apiKey"'), "no apiKey anywhere in the seeded file");
      },
    );
    console.log(
      "PASS test14 — ensureModelsFile seeds provider `default` from env (no apiKey written)",
    );
  }

  // ---- Test 15: ensureModelsFile env bootstrap — OPENAI_MODEL fallback -------------
  {
    const d = await freshDir("t15-openai");
    await withEnv({ MODEL: undefined, OPENAI_MODEL: "ollama" }, async () => {
      const file = await ensureModelsFile(d);
      assert(file.models.providers.default.models[0].id === "ollama", `OPENAI_MODEL fallback`);
    });
    console.log("PASS test15 — ensureModelsFile falls back to OPENAI_MODEL when MODEL unset");
  }

  // ---- Test 16: ensureModelsFile no env -> single DEFAULT_MODEL entry, no base/ctx, no key
  {
    const d = await freshDir("t16-noenv");
    await withEnv(
      { MODEL: undefined, OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined },
      async () => {
        const file = await ensureModelsFile(d);
        const e = file.models.providers.default.models[0];
        assert(e.id === DEFAULT_MODEL, `default model id: ${e.id}`);
        assert(e.name === DEFAULT_MODEL, "name matches id");
        assert(
          file.models.providers.default.baseUrl === undefined,
          "no provider base without API_BASE",
        );
        assert(e.contextWindow === undefined, "no contextWindow without MAX_CONTEXT_TOKENS");
        const raw = await readFile(modelsPath(d), "utf8");
        assert(!raw.includes('"apiKey"'), "no apiKey in seeded file");
      },
    );
    console.log("PASS test16 — no env -> single DEFAULT_MODEL model, no apiKey in file");
  }

  // ---- Test 17: ensureModelsFile is idempotent (existing file wins) ---------------------
  {
    const d = await freshDir("t17-idemp");
    await withEnv(
      { MODEL: "seeded", OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined },
      async () => {
        await ensureModelsFile(d); // seeds "seeded"
        const after = await ensureModelsFile(d);
        assert(after.models.providers.default.models[0].id === "seeded", "seeded model present");
        // Point env at a different model; the existing file must not be rewritten.
        await withEnv({ MODEL: "later" }, async () => {
          const stable = await ensureModelsFile(d);
          assert(
            stable.models.providers.default.models[0].id === "seeded",
            `existing file wins, not ${stable.models.providers.default.models[0].id}`,
          );
        });
      },
    );
    console.log("PASS test17 — ensureModelsFile idempotent: existing file not overwritten by new env");
  }

  // ---- Test 18: resolveModel provider/id selection -----------------------------------
  {
    const d = await freshDir("t18-providerid");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { custom: { baseUrl: "http://c/v1", apiKey: "K", models: [
            { id: "fast", name: "fast-model", contextWindow: 20000, maxTokens: 8192 },
            { id: "smart", name: "smart-model", contextWindow: 131072 },
          ] }, default: { models: [{ id: "gpt-4o-mini", name: "gpt-4o-mini" }] } } },
      }),
    );
    const r: ResolvedModel = await resolveModel(d, { selection: "custom/smart" });
    assert(r.providerId === "custom" && r.id === "smart", `provider/id resolves: ${r.providerId}/${r.id}`);
    assert(r.name === "smart-model", `name (API value): ${r.name}`);
    assert(r.selection === "custom/smart", `selection round-trips: ${r.selection}`);
    assert(r.baseUrl === "http://c/v1", `provider baseUrl: ${r.baseUrl}`);
    assert(r.apiKey === "K", `provider apiKey: ${r.apiKey}`);
    assert(r.contextWindow === 131072, `raw contextWindow: ${r.contextWindow}`);
    assert(r.maxTokens === undefined, `smart has no maxTokens`);
    console.log("PASS test18 — resolveModel `provider/id` selects and threads all fields");
  }

  // ---- Test 19: resolveModel bare id, unique across providers ----------------------
  {
    const d = await freshDir("t19-bare");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { custom: { models: [{ id: "fast", name: "fast-model" }] },
          other: { models: [{ id: "gpt-4o-mini", name: "gpt-4o-mini" }] } } },
      }),
    );
    const r = await resolveModel(d, { selection: "fast" });
    assert(r.providerId === "custom" && r.id === "fast", `bare unique id resolves: ${r.providerId}/${r.id}`);
    assert(r.selection === "custom/fast", `selection is full provider/id: ${r.selection}`);
    console.log("PASS test19 — resolveModel bare id works when unique across providers");
  }

  // ---- Test 20: resolveModel bare id ambiguous -> error listing all matches ----------
  {
    const d = await freshDir("t20-ambiguous");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { a: { models: [{ id: "dup", name: "dup-a" }] },
          b: { models: [{ id: "dup", name: "dup-b" }] } } },
      }),
    );
    await expectThrow(() => resolveModel(d, { selection: "dup" }), [
      'model "dup" is ambiguous',
      "exists in multiple providers",
      "matches: a/dup, b/dup",
    ]);
    console.log("PASS test20 — bare id in multiple providers -> ambiguous error");
  }

  // ---- Test 21: no selection -> first provider's first model ------------------------
  {
    const d = await freshDir("t21-first");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { first: { models: [{ id: "x", name: "first-model" }, { id: "y", name: "y-model" }] },
          second: { models: [{ id: "z", name: "z-model" }] } } },
      }),
    );
    const r = await resolveModel(d, {});
    assert(r.providerId === "first" && r.id === "x", `first provider's first model: ${r.providerId}/${r.id}`);
    console.log("PASS test21 — no selection -> first provider's first model (insertion order)");
  }

  // ---- Test 22: base precedence — provider baseUrl beats everything -------------------
  {
    const d = await freshDir("t22-entrybase");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { p: { baseUrl: "http://entry/v1", models: [{ id: "a", name: "a" }] } } },
      }),
    );
    await withEnv({ API_BASE: "http://envhost:9" }, async () => {
      const r = await resolveModel(d, { baseOverride: "http://override:8" });
      assert(r.baseUrl === ensureV1Path("http://entry/v1"), `provider.baseUrl authoritative: ${r.baseUrl}`);
    });
    console.log("PASS test22 — base precedence: provider.baseUrl beats baseOverride/API_BASE");
  }

  // ---- Test 23: base precedence — baseOverride > API_BASE > DEFAULT_API_BASE ----------
  {
    const d = await freshDir("t23-overrides");
    await writeModels(
      d,
      JSON.stringify({ models: { providers: { p: { models: [{ id: "a", name: "a" }] } } } }),
    );
    {
      await withEnv({ API_BASE: undefined }, async () => {
        const r = await resolveModel(d, {});
        assert(r.baseUrl === ensureV1Path(DEFAULT_API_BASE), `default base: ${r.baseUrl}`);
      });
    }
    {
      await withEnv({ API_BASE: "http://env:7" }, async () => {
        const r = await resolveModel(d, {});
        assert(r.baseUrl === ensureV1Path("http://env:7"), `API_BASE used: ${r.baseUrl}`);
      });
    }
    {
      await withEnv({ API_BASE: "http://env:7" }, async () => {
        const r = await resolveModel(d, { baseOverride: "http://ov:6" });
        assert(r.baseUrl === ensureV1Path("http://ov:6"), `baseOverride > API_BASE: ${r.baseUrl}`);
      });
    }
    console.log("PASS test23 — base precedence: provider.baseUrl > baseOverride > API_BASE > DEFAULT_API_BASE");
  }

  // ---- Test 24: /v1 normalization on all base sources -------------------------------
  {
    const d = await freshDir("t24-v1");
    await writeModels(
      d,
      JSON.stringify({ models: { providers: { p: { models: [{ id: "a", name: "a" }] } } } }),
    );
    await withEnv({ API_BASE: "http://no-slash:7" }, async () => {
      const r = await resolveModel(d, { baseOverride: null });
      assert(r.baseUrl.endsWith("/v1"), `normalized to /v1: ${r.baseUrl}`);
      assert(!r.baseUrl.endsWith("/v1/"), "no double /v1");
    });
    const d2 = await freshDir("t24b-entry");
    await writeModels(
      d2,
      JSON.stringify({ models: { providers: { p: { baseUrl: "http://e:5", models: [{ id: "a", name: "a" }] } } } }),
    );
    const r2 = await resolveModel(d2, {});
    assert(r2.baseUrl === ensureV1Path("http://e:5"), `provider base normalized: ${r2.baseUrl}`);
    console.log("PASS test24 — every base source normalized to /v1");
  }

  // ---- Test 25: apiKey — provider value wins; null when provider has none ----------
  {
    const d = await freshDir("t25-key");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { keyed: { baseUrl: "http://k/v1", apiKey: "provider-key", models: [{ id: "a", name: "a" }] },
          unkeyed: { baseUrl: "http://u/v1", models: [{ id: "a", name: "a" }] } } },
      }),
    );
    await withEnv({ OPENAI_API_KEY: "env-key" }, async () => {
      const rK = await resolveModel(d, { selection: "keyed/a" });
      assert(rK.apiKey === "provider-key", `provider key wins: ${rK.apiKey}`);
      const rU = await resolveModel(d, { selection: "unkeyed/a" });
      assert(rU.apiKey === null, `no provider key -> null (caller falls back): ${JSON.stringify(rU.apiKey)}`);
    });
    console.log("PASS test25 — resolveModel apiKey: provider value wins, null otherwise");
  }

  // ---- Test 26: raw contextWindow/maxTokens thread (undefined when unset) ----------
  {
    const d = await freshDir("t26-raw");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { p: { models: [
            { id: "a", name: "a", contextWindow: 24000, maxTokens: 4096 },
            { id: "b", name: "b" },
          ] } } },
      }),
    );
    await withEnv({ MAX_CONTEXT_TOKENS: "80000" }, async () => {
      const rA = await resolveModel(d, { selection: "a" });
      assert(rA.contextWindow === 24000, `raw contextWindow: ${rA.contextWindow}`);
      assert(rA.maxTokens === 4096, `raw maxTokens: ${rA.maxTokens}`);
      const rB = await resolveModel(d, { selection: "b" });
      assert(rB.contextWindow === undefined, `unset -> undefined: ${JSON.stringify(rB.contextWindow)}`);
      assert(rB.maxTokens === undefined, `unset -> undefined: ${JSON.stringify(rB.maxTokens)}`);
    });
    console.log(
      "PASS test26 — raw contextWindow/maxTokens thread through; env fallback happens downstream",
    );
  }

  // ---- Test 27: resolveModel auto-seeds from env when file absent ----------------------
  {
    const d = await freshDir("t27-autoseed");
    await withEnv({ MODEL: "seed", OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined }, async () => {
      const r = await resolveModel(d, {});
      assert(r.selection === `default/${r.id}`, `auto-seeded selection: ${r.selection}`);
      assert(r.id === "seed" && r.name === "seed", `auto-seeded id/name: ${r.id}/${r.name}`);
      const loaded = await loadModelsFile(d);
      assert(loaded !== null, "file auto-created and persisted");
      const raw = await readFile(modelsPath(d), "utf8");
      assert(!raw.includes('"apiKey"'), "auto-seed wrote no apiKey");
    });
    console.log("PASS test27 — resolveModel auto-seeds models.json (no apiKey) when file is missing");
  }

  // ---- Test 28: unknown provider lists available provider/id entries ----------------
  {
    const d = await freshDir("t28-unknownprov");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { custom: { models: [{ id: "a", name: "aa" }, { id: "b", name: "bb" }] } } },
      }),
    );
    let err = "";
    try {
      await resolveModel(d, { selection: "no-provider/a" });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err !== "", "unknown provider should throw");
    assert(err.includes('unknown provider "no-provider"'), `unknown-provider message: ${err}`);
    assert(err.includes('in ' + d + "/models.json"), "lists cwd file");
    assert(err.includes("available: custom/a, custom/b"), `lists available provider/ids: ${err}`);
    console.log("PASS test28 — unknown provider throws listing available provider/id entries");
  }

  // ---- Test 29: unknown model (provider/id) lists that provider's models + all ------
  {
    const d = await freshDir("t29-unknownmodel");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { custom: { models: [{ id: "a", name: "aa" }] }, other: { models: [{ id: "b", name: "bb" }] } } } },
      ),
    );
    let err = "";
    try {
      await resolveModel(d, { selection: "custom/nope" });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err !== "", "unknown model should throw");
    assert(err.includes('unknown model "nope" in provider "custom"'), `unknown-model message: ${err}`);
    assert(err.includes("provider models: a"), `lists provider models: ${err}`);
    assert(err.includes("all: custom/a, other/b"), `lists all available: ${err}`);
    console.log("PASS test29 — unknown model in provider throws listing provider models + all");
  }

  // ---- Test 30: unknown bare id lists all available provider/id entries ---------------
  {
    const d = await freshDir("t30-unknownbare");
    await writeModels(
      d,
      JSON.stringify({
        models: { providers: { custom: { models: [{ id: "a", name: "aa" }] } } },
      }),
    );
    let err = "";
    try {
      await resolveModel(d, { selection: "nope" });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err !== "", "unknown bare id should throw");
    assert(err.includes('unknown model "nope"'), `unknown-bare message: ${err}`);
    assert(err.includes("available: custom/a"), `lists available provider/id: ${err}`);
    console.log("PASS test30 — unknown bare id throws listing available provider/id entries");
  }

  // ---- Test 31: flagValue last-value-wins -------------------------------------------
  {
    const r = flagValue(["--model", "a", "--model", "b"], "--model");
    assert(r === "b", `last-value-wins: ${r}`);
    console.log("PASS test31 — flagValue last-value-wins");
  }

  // ---- Test 32: flagValue --name=value form ------------------------------------------
  {
    const r = flagValue(["--model=smart", "extra"], "--model");
    assert(r === "smart", `--name=value: ${r}`);
    console.log("PASS test32 — flagValue --name=value form");
  }

  // ---- Test 33: flagValue absent -> null ----------------------------------------------
  {
    const r = flagValue(["--other", "x"], "--model");
    assert(r === null, `absent -> null: ${JSON.stringify(r)}`);
    console.log("PASS test33 — flagValue absent -> null");
  }

  // ---- Test 34: flagValue next element is a flag -> null (no usable value) -------------
  {
    const r = flagValue(["--model", "--other"], "--model");
    assert(r === null, `flag with no value -> null: ${JSON.stringify(r)}`);
    console.log("PASS test34 — flagValue value that is a flag -> null");
  }

  // ---- Test 35: flagValue empty --name= value -> null ---------------------------------
  {
    const r = flagValue(["--model="], "--model");
    assert(r === null, `empty --name= -> null: ${JSON.stringify(r)}`);
    console.log("PASS test35 — flagValue empty --name= value -> null");
  }

  console.log("\nALL MODELS TESTS PASSED");
} catch (e) {
  process.exitCode = 1;
  console.error("models-test FAILED");
  console.error(e);
} finally {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true }).catch(() => {});
}
process.exit(0);
