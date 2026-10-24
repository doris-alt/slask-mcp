// models-test.ts — drive the multi-model catalog (models.ts) in-process, fully
// network-free.
//
// No live model endpoint. The catalog is pure file + env plumbing, so every
// test uses a fresh empty cwd and exercises load/save/resolve + the argv
// `flagValue` helper. A fresh empty directory (no ./skills/) keeps `discoverSkills`
// empty, which is irrelevant here but harmless.
//
// Covers:
//   * loadModelsFile: missing -> null; malformed JSON -> "not valid JSON"; wrong
//     shape -> "must be JSON with a \"models\" array".
//   * saveModelsFile / round-trip.
//   * entry validation: missing/empty id, missing/empty name, empty baseUrl,
//     invalid maxContext (float / sub-2000 / NaN / null), non-boolean default,
//     duplicate id.
//   * ensureModelsFile env bootstrap: MODEL/OPENAI_MODEL -> id/name; API_BASE ->
//     baseUrl; MAX_CONTEXT_TOKENS -> maxContext; default: true; idempotency;
//     no-env -> single default entry (DEFAULT_MODEL).
//   * resolveModel: id selection, default:true fallback, first-entry fallback;
//     base precedence (entry.baseUrl > baseOverride > API_BASE > DEFAULT_API_BASE)
//     with /v1 normalization; maxContext precedence (entry.maxContext > env >
//     DEFAULT_CONTEXT_TOKENS); auto-seed from env when file absent.
//   * resolveModel strict unknown-id error listing the available ids.
//   * flagValue: last-value-wins, --name=value, absent -> null, no-usable-value -> null.

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_API_BASE,
  DEFAULT_CONTEXT_TOKENS,
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
import type { ModelEntry } from "../models.js";

// ---------------------------------------------------------------------------
// Work from a fresh, empty cwd.
// ---------------------------------------------------------------------------
const originalCwd = process.cwd();
const workDir = join(
  tmpdir(),
  `slask-models-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

async function expectThrow(fn: () => Promise<unknown>, substrings?: string[]): Promise<void> {
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
    process.chdir(d);
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

  // ---- Test 3: wrong shape -> "must be JSON with a \"models\" array" ----------
  {
    const d = await freshDir("t3-badshape");
    await writeModels(d, '{"foo": ["a"]}');
    await expectThrow(() => loadModelsFile(d), ['must be JSON with a "models" array']);
    console.log('PASS test3 — loadModelsFile wrong shape -> "must be JSON with a \"models\" array"');
  }

  // ---- Test 4: empty top-level object / array shape --------------------------
  {
    const d1 = await freshDir("t4a-emptyobj");
    await writeModels(d1, "{}");
    await expectThrow(() => loadModelsFile(d1), ['must be JSON with a "models" array']);
    const d2 = await freshDir("t4b-array");
    await writeModels(d2, "[]");
    await expectThrow(() => loadModelsFile(d2), ['must be JSON with a "models" array']);
    console.log("PASS test4 — loadModelsFile empty-object / bare-array shapes rejected");
  }

  // ---- Test 5: saveModelsFile round-trip -------------------------------------
  {
    const d = await freshDir("t5-roundtrip");
    const entries: ModelEntry[] = [
      { id: "a", name: "model-a", baseUrl: "http://x/v1", maxContext: 100000, default: true },
      { id: "b", name: "model-b" },
    ];
    await saveModelsFile(d, entries);
    const raw = await readFile(modelsPath(d), "utf8");
    const loaded = (await loadModelsFile(d)) ?? [];
    assert(loaded.length === 2, `round-trip length 2: ${loaded.length}`);
    assert(loaded[0].id === "a" && loaded[0].default === true && loaded[0].maxContext === 100000);
    assert(loaded[1].id === "b" && loaded[1].name === "model-b");
    assert(JSON.parse(raw).models.length === 2, "raw file is a {models:[...]} object");
    console.log("PASS test5 — saveModelsFile round-trips all fields");
  }

  // ---- Test 6: entry validation — missing id ---------------------------------
  {
    const d = await freshDir("t6-noid");
    await writeModels(d, JSON.stringify({ models: [{ name: "x" }] }));
    await expectThrow(() => loadModelsFile(d), ['is missing a non-empty "id"']);
    console.log('PASS test6 — entry validation: missing id rejected');
  }

  // ---- Test 7: entry validation — missing name ---------------------------------
  {
    const d = await freshDir("t7-noname");
    await writeModels(d, JSON.stringify({ models: [{ id: "a" }] }));
    await expectThrow(() => loadModelsFile(d), [
      `(id="a") is missing a non-empty "name"`,
    ]);
    console.log('PASS test7 — entry validation: missing name rejected');
  }

  // ---- Test 8: entry validation — empty baseUrl ----------------------------------
  {
    const d = await freshDir("t8-emptybase");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "x", baseUrl: "   " }] }));
    await expectThrow(() => loadModelsFile(d), ['entry "a" has an empty "baseUrl"']);
    console.log('PASS test8 — entry validation: empty baseUrl rejected');
  }

  // ---- Test 9: entry validation — invalid maxContext -----------------------------
  {
    const d = await freshDir("t9-badctx");
    const bad = [
      { id: "a", name: "x", maxContext: 3000.5 }, // float
      { id: "a", name: "x", maxContext: 1000 }, // < 2000
      { id: "a", name: "x", maxContext: "abc" }, // NaN
      { id: "a", name: "x", maxContext: null }, // 0 -> < 2000
      { id: "a", name: "x", maxContext: 1500 }, // < 2000
    ];
    for (const entry of bad) {
      const dd = await freshDir("t9-case");
      await writeModels(dd, JSON.stringify({ models: [entry] }));
      await expectThrow(() => loadModelsFile(dd), [
        `entry "a" has an invalid "maxContext"`,
        "(must be an integer",
      ]);
    }
    console.log("PASS test9 — entry validation: float/sub-2000/NaN/null maxContext rejected");
  }

  // ---- Test 10: entry validation — non-boolean default ---------------------------
  {
    const d = await freshDir("t10-baddef");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "x", default: "yes" }] }));
    await expectThrow(() => loadModelsFile(d), ['entry "a" "default" must be a boolean']);
    console.log("PASS test10 — entry validation: non-boolean default rejected");
  }

  // ---- Test 11: entry validation — duplicate id ------------------------------------
  {
    const d = await freshDir("t11-dup");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "1" }, { id: "a", name: "2" }] }));
    await expectThrow(() => loadModelsFile(d), ['duplicate id "a"', "ids must be unique"]);
    console.log("PASS test11 — entry validation: duplicate id rejected");
  }

  // ---- Test 12: ensureModelsFile env bootstrap — full env -------------------------
  {
    const d = await freshDir("t12-env");
    const ctx = "90000";
    await withEnv(
      {
        MODEL: "my-model",
        OPENAI_MODEL: undefined,
        API_BASE: "http://myhost:8000",
        MAX_CONTEXT_TOKENS: ctx,
      },
      async () => {
        const entries = await ensureModelsFile(d);
        assert(entries.length === 1, `one seeded entry: ${entries.length}`);
        const e = entries[0];
        assert(e.id === "my-model" && e.name === "my-model", `id/name from MODEL: ${e.id}/${e.name}`);
        assert(e.baseUrl === "http://myhost:8000", `baseUrl from API_BASE: ${e.baseUrl}`);
        assert(e.maxContext === 90000, `maxContext from env: ${e.maxContext}`);
        assert(e.default === true, "seeded entry is default");
        assert(await loadModelsFile(d) !== null, "file now exists on disk");
        const raw = await readFile(modelsPath(d), "utf8");
        assert(JSON.parse(raw).models[0].id === "my-model", "file persists seeded entry");
      },
    );
    console.log("PASS test12 — ensureModelsFile seeds models.json from env (MODEL/API_BASE/MAX_CONTEXT_TOKENS)");
  }

  // ---- Test 13: ensureModelsFile env bootstrap — OPENAI_MODEL fallback ------------
  {
    const d = await freshDir("t13-openai");
    await withEnv({ MODEL: undefined, OPENAI_MODEL: "ollama" }, async () => {
      const entries = await ensureModelsFile(d);
      assert(entries[0].id === "ollama" && entries[0].name === "ollama", `OPENAI_MODEL fallback`);
    });
    console.log("PASS test13 — ensureModelsFile falls back to OPENAI_MODEL when MODEL unset");
  }

  // ---- Test 14: ensureModelsFile with no env vars -> single default entry ----------
  {
    const d = await freshDir("t14-noenv");
    await withEnv(
      { MODEL: undefined, OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined },
      async () => {
        const entries = await ensureModelsFile(d);
        assert(entries.length === 1, "no-env -> one default entry");
        const e = entries[0];
        assert(e.id === DEFAULT_MODEL && e.name === DEFAULT_MODEL, `default is ${DEFAULT_MODEL}`);
        assert(e.default === true, "default entry marked");
        assert(e.baseUrl === undefined && e.maxContext === undefined, "no base/ctx without env");
      },
    );
    console.log("PASS test14 — ensureModelsFile no env -> single DEFAULT_MODEL entry");
  }

  // ---- Test 15: ensureModelsFile is idempotent --------------------------------------
  {
    const d = await freshDir("t15-idemp");
    await withEnv({ MODEL: "seeded", OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined }, async () => {
      await ensureModelsFile(d); // seeds "seeded"
      assert((await loadModelsFile(d))?.[0].id === "seeded", "seeded entry present");
      // Now point env at a DIFFERENT model; ensureModelsFile must NOT rewrite it.
      await withEnv({ MODEL: "later" }, async () => {
        const entries = await ensureModelsFile(d);
        assert(entries.length === 1 && entries[0].id === "seeded", `existing file wins, not ${entries[0].id}`);
        assert(entries[0].default === true, "existing entry still default");
      });
    });
    console.log("PASS test15 — ensureModelsFile idempotent: existing file not overwritten by new env");
  }

  // ---- Test 16: resolveModel explicit id selection ------------------------------------
  {
    const d = await freshDir("t16-id");
    await writeModels(
      d,
      JSON.stringify({
        models: [
          { id: "fast", name: "fast-model", default: true, maxContext: 20000 },
          { id: "smart", name: "smart-model", baseUrl: "http://s/v1", maxContext: 131072 },
        ],
      }),
    );
    const r = await resolveModel(d, { id: "smart" });
    assert(r.id === "smart" && r.name === "smart-model", `selects smart: ${r.id}/${r.name}`);
    assert(r.baseUrl === "http://s/v1", `smart baseUrl: ${r.baseUrl}`);
    assert(r.maxContext === 131072, `smart maxContext: ${r.maxContext}`);
    console.log("PASS test16 — resolveModel explicit id selects the matching entry");
  }

  // ---- Test 17: resolveModel no id -> default:true fallback --------------------------
  {
    const d = await freshDir("t17-def");
    await writeModels(
      d,
      JSON.stringify({
        models: [
          { id: "first", name: "first-model" },
          { id: "def", name: "def-model", default: true },
          { id: "last", name: "last-model" },
        ],
      }),
    );
    const r = await resolveModel(d, { id: undefined });
    assert(r.id === "def" && r.name === "def-model", `default:true wins: ${r.id}`);
    console.log("PASS test17 — resolveModel no id picks the default:true entry");
  }

  // ---- Test 18: resolveModel no id no default -> first entry -------------------------
  {
    const d = await freshDir("t18-first");
    await writeModels(
      d,
      JSON.stringify({
        models: [
          { id: "first", name: "first-model" },
          { id: "second", name: "second-model" },
        ],
      }),
    );
    const r = await resolveModel(d, { id: null });
    assert(r.id === "first" && r.name === "first-model", `first entry wins: ${r.id}`);
    console.log("PASS test18 — resolveModel no id no default -> first entry");
  }

  // ---- Test 19: base precedence — entry.baseUrl beats everything --------------------
  {
    const d = await freshDir("t19-entrybase");
    await writeModels(
      d,
      JSON.stringify({
        models: [
          { id: "a", name: "a", baseUrl: "http://entry/v1", default: true },
        ],
      }),
    );
    await withEnv({ API_BASE: "http://envhost:9" }, async () => {
      const r = await resolveModel(d, { baseOverride: "http://override:8" });
      assert(
        r.baseUrl === ensureV1Path("http://entry/v1"),
        `entry.baseUrl authoritative: ${r.baseUrl}`
      );
    });
    console.log("PASS test19 — resolveModel base: entry.baseUrl beats baseOverride/API_BASE");
  }

  // ---- Test 20: base precedence — baseOverride > API_BASE > DEFAULT_API_BASE ---------
  {
    const d = await freshDir("t20-overrides");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "a", default: true }] }));
    {
      // no env -> DEFAULT_API_BASE
      await withEnv({ API_BASE: undefined }, async () => {
        const r = await resolveModel(d, {});
        assert(r.baseUrl === ensureV1Path(DEFAULT_API_BASE), `default base: ${r.baseUrl}`);
      });
    }
    {
      // API_BASE when no baseOverride
      await withEnv({ API_BASE: "http://env:7" }, async () => {
        const r = await resolveModel(d, {});
        assert(r.baseUrl === ensureV1Path("http://env:7"), `API_BASE used: ${r.baseUrl}`);
      });
    }
    {
      // baseOverride beats API_BASE
      await withEnv({ API_BASE: "http://env:7" }, async () => {
        const r = await resolveModel(d, { baseOverride: "http://ov:6" });
        assert(r.baseUrl === ensureV1Path("http://ov:6"), `baseOverride > API_BASE: ${r.baseUrl}`);
      });
    }
    console.log("PASS test20 — resolveModel base precedence: baseOverride > API_BASE > DEFAULT_API_BASE");
  }

  // ---- Test 21: /v1 normalization on all base sources -------------------------------
  {
    const d = await freshDir("t21-v1");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "a", default: true }] }));
    await withEnv({ API_BASE: "http://no-slash:7" }, async () => {
      const r = await resolveModel(d, { baseOverride: null });
      assert(r.baseUrl.endsWith("/v1"), `normalized to /v1: ${r.baseUrl}`);
      assert(!r.baseUrl.endsWith("/v1/"), "no double /v1");
    });
    // entry baseUrl without /v1 is normalized too
    const d2 = await freshDir("t21b-entry");
    await writeModels(d2, JSON.stringify({ models: [{ id: "a", name: "a", baseUrl: "http://e:5", default: true }] }));
    const r2 = await resolveModel(d2, {});
    assert(r2.baseUrl === ensureV1Path("http://e:5"), `entry base normalized: ${r2.baseUrl}`);
    console.log("PASS test21 — resolveModel normalizes every base source to /v1");
  }

  // ---- Test 22: maxContext precedence — entry.maxContext > env > DEFAULT -------------
  {
    const d = await freshDir("t22-entryctx");
    await writeModels(d, JSON.stringify({ models: [{ id: "a", name: "a", maxContext: 50000, default: true }] }));
    await withEnv({ MAX_CONTEXT_TOKENS: "80000" }, async () => {
      const r = await resolveModel(d, {});
      assert(r.maxContext === 50000, `entry.maxContext > env: ${r.maxContext}`);
    });
    // env wins over default when entry has none
    const d2 = await freshDir("t22b-env");
    await writeModels(d2, JSON.stringify({ models: [{ id: "a", name: "a", default: true }] }));
    await withEnv({ MAX_CONTEXT_TOKENS: "80000" }, async () => {
      const r = await resolveModel(d2, {});
      assert(r.maxContext === 80000, `env wins: ${r.maxContext}`);
    });
    // default wins when neither present
    await withEnv({ MAX_CONTEXT_TOKENS: undefined }, async () => {
      const r = await resolveModel(d2, {});
      assert(r.maxContext === DEFAULT_CONTEXT_TOKENS, `default wins: ${r.maxContext}`);
    });
    console.log("PASS test22 — resolveModel maxContext precedence: entry > env > DEFAULT_CONTEXT_TOKENS");
  }

  // ---- Test 23: resolveModel auto-seeds from env when file absent --------------------
  {
    const d = await freshDir("t23-autoseed");
    await withEnv({ MODEL: "seed", OPENAI_MODEL: undefined, API_BASE: undefined, MAX_CONTEXT_TOKENS: undefined }, async () => {
      const r = await resolveModel(d, { id: undefined });
      assert(r.id === "seed" && r.name === "seed", `auto-seeded id: ${r.id}`);
      const loaded = await loadModelsFile(d);
      assert(loaded !== null && loaded[0].id === "seed", "file auto-created and persisted");
    });
    console.log("PASS test23 — resolveModel auto-seeds models.json when file is missing");
  }

  // ---- Test 24: resolveModel strict unknown-id lists available ids --------------------
  {
    const d = await freshDir("t24-unknown");
    await writeModels(
      d,
      JSON.stringify({ models: [{ id: "a", name: "aa", default: true }, { id: "b", name: "bb" }] }),
    );
    let err = "";
    try {
      await resolveModel(d, { id: "nope" });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    assert(err !== "", "unknown id should throw");
    assert(err.includes(`unknown model id "nope"`), `unknown-id message: ${err}`);
    assert(err.includes('in ' + d + "/models.json"), "lists cwd file: " + err);
    assert(err.includes("available ids: a, b"), `lists available ids: ${err}`);
    console.log("PASS test24 — resolveModel unknown id throws listing available ids");
  }

  // ---- Test 25: flagValue last-value-wins -----------------------------------------------
  {
    const d = await freshDir("t25-lastwin");
    const r = flagValue(["--model", "a", "--model", "b"], "--model");
    assert(r === "b", `last-value-wins: ${r}`);
    console.log("PASS test25 — flagValue last-value-wins");
  }

  // ---- Test 26: flagValue --name=value form ----------------------------------------------
  {
    const r = flagValue(["--model=smart", "extra"], "--model");
    assert(r === "smart", `--name=value: ${r}`);
    console.log("PASS test26 — flagValue --name=value form");
  }

  // ---- Test 27: flagValue absent -> null -------------------------------------------------
  {
    const r = flagValue(["--other", "x"], "--model");
    assert(r === null, `absent -> null: ${JSON.stringify(r)}`);
    console.log("PASS test27 — flagValue absent -> null");
  }

  // ---- Test 28: flagValue next element is a flag -> null (no usable value) --------------
  {
    const r = flagValue(["--model", "--other"], "--model");
    assert(r === null, `flag with no value -> null: ${JSON.stringify(r)}`);
    console.log("PASS test28 — flagValue value that is a flag -> null");
  }

  // ---- Test 29: flagValue empty --name= value -> null -----------------------------------
  {
    const r = flagValue(["--model="], "--model");
    assert(r === null, `empty --name= -> null: ${JSON.stringify(r)}`);
    console.log("PASS test29 — flagValue empty --name= value -> null");
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
