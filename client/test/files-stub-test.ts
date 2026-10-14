// files-stub-test.ts — standalone tests for the built-in file tools (files.ts).
//
// No MCP server and no model endpoint needed: `baseDir` is an explicit argument
// (not `process.cwd()`), so everything runs against a throwaway temp tree and an
// "outside" temp tree that must stay unreachable. Symlinks crossing from `root`
// to `outside` are the escape vector. Mirrors the skills-stub patterns:
// `assert/strict`, a `thrown` helper for async rejections, `tmpdir()` workspaces.
import assert from "node:assert/strict";
import {
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CallToolResult } from "../types.js";
import {
  callFileTool,
  editFileInBase,
  fileTools,
  resolveExistingInBase,
  resolveInBase,
  readFileInBase,
  writeFileInBase,
} from "../files.js";

// callFileTool always returns a single text part.
const textOf = (r: CallToolResult): string => {
  const first = r.content[0];
  assert(first.type === "text", JSON.stringify(first));
  return first.text;
};

// assert.throws only sees *synchronous* throws; capture rejections **and**
// synchronous throws (used for both sync `resolveInBase` and the async ops)
// by awaiting inside a try/catch.
const thrown = async (f: () => unknown): Promise<string> => {
  let message = "";
  try {
    await f();
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert(message !== "", "expected a throw but got none");
  return message;
};

// ---------------------------------------------------------------------------
// workspaces: `root` is the launch dir (baseDir); `outside` must stay
// unreachable. Symlinks crossing from root to outside are the escape vector.
// ---------------------------------------------------------------------------
const root = join(tmpdir(), `slask-files-stub-${Date.now()}`);
const outside = join(
  tmpdir(),
  `slask-files-outside-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);
await mkdir(root, { recursive: true });
await mkdir(outside, { recursive: true });

const insideOutTxt = join(outside, "outside.txt");
await writeFile(join(root, "notes.txt"), "line one\nline two\nline three\n", "utf8");
await writeFile(insideOutTxt, "secret outside content", "utf8");
await writeFile(join(outside, "secret.txt"), "secret outside file", "utf8");

const disk = async (p: string): Promise<string> => readFile(p, "utf8");

// ---------------------------------------------------------------------------
// 1. resolveInBase — string-level containment (empty, absolute, escapes) -----
// ---------------------------------------------------------------------------
{
  assert(resolveInBase(root, "notes.txt").endsWith("notes.txt"));
  assert(resolveInBase(root, "./notes.txt").endsWith("notes.txt"));
  assert(resolveInBase(root, "sub/dir/f.txt").endsWith("sub/dir/f.txt"));

  const mAbs = await thrown(() => resolveInBase(root, "/etc/passwd"));
  assert(/absolute paths are not allowed/.test(mAbs), mAbs);

  const m1 = await thrown(() => resolveInBase(root, ".."));
  assert(/escapes the launch directory/.test(m1), m1);
  const m2 = await thrown(() => resolveInBase(root, "../x.txt"));
  assert(/escapes the launch directory/.test(m2), m2);
  const m3 = await thrown(() => resolveInBase(root, "a/../../etc/passwd"));
  assert(/escapes the launch directory/.test(m3), m3);
  const m4 = await thrown(() => resolveInBase(root, ""));
  assert(/path must not be empty/.test(m4), m4);
  console.log("PASS test1 — resolveInBase escapes are rejected");
}

// ---------------------------------------------------------------------------
// 2. symlink escape: a link inside root pointing outside is refused; a link
// inside root pointing inside root is fine; a symlinked *dir* pointing outside
// is refused when followed into a file ----------------------------------------
// ---------------------------------------------------------------------------
{
  // link inside root -> file outside (string layer passes, symlink layer must reject)
  const linkInsideOut = join(root, "link.txt");
  await symlink(insideOutTxt, linkInsideOut);
  const m = await resolveExistingInBase(root, linkInsideOut).catch((e: Error) => e);
  assert(
    m instanceof Error && /escapes the launch directory \(symlink\)/.test(m.message),
    `expected symlink-escape rejection, got ${m instanceof Error ? m.message : String(m)}`
  );

  // link inside root -> file inside root (allowed)
  await writeFile(join(root, "inner.txt"), "inner content", "utf8");
  const innerLink = join(root, "inlink.txt");
  await symlink(join(root, "inner.txt"), innerLink);
  await resolveExistingInBase(root, innerLink); // must not throw

  // symlinked directory pointing outside, followed into a file
  await symlink(outside, join(root, "escdir"));
  const mDir = await resolveExistingInBase(
    root,
    join(root, "escdir", "secret.txt"),
  ).catch((e: Error) => e);
  assert(
    mDir instanceof Error && /escapes the launch directory \(symlink\)/.test(mDir.message),
    `expected symlinked-dir escape rejection, got ${mDir instanceof Error ? mDir.message : String(mDir)}`
  );
  console.log("PASS test2 — symlink escapes rejected, in-base links allowed");
}

// ---------------------------------------------------------------------------
// 3. readFileInBase: round-trip, missing, directory, binary, empty, truncation
// ---------------------------------------------------------------------------
{
  const r = await readFileInBase(root, "notes.txt");
  assert(r.path.endsWith("notes.txt"), r.path);
  assert(r.content === "line one\nline two\nline three\n", r.content);
  assert(r.totalBytes > 0, String(r.totalBytes));
  assert(r.truncated === false, String(r.truncated));

  const mMiss = await thrown(() => readFileInBase(root, "nope.txt"));
  assert(/no such file/.test(mMiss), mMiss);

  await mkdir(join(root, "subdir"), { recursive: true });
  const mDir = await thrown(() => readFileInBase(root, "subdir"));
  assert(/is a directory/.test(mDir), mDir);

  await writeFile(join(root, "bin.dat"), Buffer.from([0x68, 0x65, 0x00, 0x6c, 0x6c, 0x6f]));
  const mBin = await thrown(() => readFileInBase(root, "bin.dat"));
  assert(/not a plain text file/.test(mBin), mBin);

  await writeFile(join(root, "empty.txt"), "");
  const empty = await readFileInBase(root, "empty.txt");
  assert(empty.content === "" && empty.totalBytes === 0 && empty.truncated === false);

  // oversize -> truncated flag, totalBytes = real size, content capped at 64KiB
  const BIG = 200_000;
  await writeFile(join(root, "big.txt"), "a".repeat(BIG));
  const big = await readFileInBase(root, "big.txt");
  assert(big.truncated === true, String(big.truncated));
  assert(big.totalBytes === BIG, String(big.totalBytes));
  assert(big.content.length === 65536, String(big.content.length));
  console.log("PASS test3 — readFileInBase (round-trip, missing, dir, binary, truncated)");
}

// ---------------------------------------------------------------------------
// 4. editFileInBase: no match, multi (with/without replaceAll), empty search,
// delete, single match, subdir ----------------------------------------------
// ---------------------------------------------------------------------------
{
  await writeFile(join(root, "f.txt"), "a b a b\nx y\n", "utf8");

  // no match -> throw
  const mNoMatch = await thrown(() =>
    editFileInBase(root, "f.txt", "zzz", "q", false),
  );
  assert(/no match for the search string/.test(mNoMatch), mNoMatch);

  // empty search -> throw
  const mEmptySearch = await thrown(() =>
    editFileInBase(root, "f.txt", "", "q", false),
  );
  assert(/search must be a non-empty string/.test(mEmptySearch), mEmptySearch);

  // multiple matches, replaceAll false -> throw with count
  const mMulti = await thrown(() => editFileInBase(root, "f.txt", "a", "X", false));
  assert(/matches 2 times/.test(mMulti), mMulti);

  // multiple matches, replaceAll true -> replaces all (verify on disk)
  await editFileInBase(root, "f.txt", "a", "X", true);
  assert((await disk(join(root, "f.txt"))) === "X b X b\nx y\n");

  // single match (replace "x" — appears once now)
  await editFileInBase(root, "f.txt", "x", "y", false);
  assert((await disk(join(root, "f.txt"))) === "X b X b\ny y\n");

  // delete via empty replace
  await writeFile(join(root, "f2.txt"), "keep REMOVE this keep\n", "utf8");
  const dr = await editFileInBase(root, "f2.txt", "REMOVE", "", false);
  assert(dr.matched === 1, String(dr.matched));
  assert((await disk(join(root, "f2.txt"))) === "keep  this keep\n");

  // subdir edit
  await mkdir(join(root, "deeper"), { recursive: true });
  await writeFile(join(root, "deeper", "g.txt"), "one\ntwo\n");
  await editFileInBase(root, "deeper/g.txt", "two", "TWO", false);
  assert((await disk(join(root, "deeper", "g.txt"))) === "one\nTWO\n");

  console.log("PASS test4 — editFileInBase (no-match, multi, delete, subdir)");
}

// ---------------------------------------------------------------------------
// 5. writeFileInBase: create, nested parents, overwrite, missing content,
// directory target, escape, symlinked-escape-parent --------------------------
// ---------------------------------------------------------------------------
{
  // create
  const w = await writeFileInBase(root, "new.txt", "hello");
  assert(w.created === true, String(w.created));
  assert(w.path === "new.txt", w.path);
  assert((await disk(join(root, "new.txt"))) === "hello");

  // nested path auto-creates parents (all inside base)
  const w2 = await writeFileInBase(root, "a/b/c.txt", "deep");
  assert(w2.created === true, String(w2.created));
  assert((await disk(join(root, "a", "b", "c.txt"))) === "deep");

  // overwrite
  const w3 = await writeFileInBase(root, "new.txt", "hello again");
  assert(w3.created === false, String(w3.created));
  assert((await disk(join(root, "new.txt"))) === "hello again");

  // missing content -> throw
  const mNoContent = await thrown(() => writeFileInBase(root, "nope.txt", undefined));
  assert(/content is required/.test(mNoContent), mNoContent);

  // existing directory as target -> throw
  const mDir = await thrown(() => writeFileInBase(root, "subdir", "x"));
  assert(/is a directory/.test(mDir), mDir);

  // string-layer escape
  const mEsc = await thrown(() => writeFileInBase(root, "../outside.txt", "x"));
  assert(/escapes the launch directory/.test(mEsc), mEsc);

  // symlinked parent pointing outside -> symlink-layer reject
  await symlink(outside, join(root, "escparent"));
  const mEscParent = await thrown(() =>
    writeFileInBase(root, "escparent/new.txt", "x"),
  );
  assert(
    /escapes the launch directory \(symlink\)/.test(mEscParent),
    mEscParent,
  );

  console.log("PASS test5 — writeFileInBase (create, nested, overwrite, reject)");
}

// ---------------------------------------------------------------------------
// 5b. writeFileInBase append mode: extend existing, create-if-missing,
//     chunked write, preserve existing content, escapes still reject ----------
// ---------------------------------------------------------------------------
{
  // append to an existing file preserves and extends its content
  await writeFileInBase(root, "app.txt", "first", false);
  const a1 = await writeFileInBase(root, "app.txt", "second", true);
  assert(a1.appended === true, String(a1.appended));
  assert(a1.created === false, String(a1.created));
  assert((await disk(join(root, "app.txt"))) === "firstsecond");

  // chunked write: first chunk overwrites, the rest append
  await writeFileInBase(root, "chunk.txt", "AAA", false);
  await writeFileInBase(root, "chunk.txt", "BBB", true);
  await writeFileInBase(root, "chunk.txt", "CCC", true);
  assert((await disk(join(root, "chunk.txt"))) === "AAABBBCCC");

  // append on a missing file creates it (created: true, appended: true)
  const a2 = await writeFileInBase(root, "newappend.txt", "solo", true);
  assert(a2.created === true, String(a2.created));
  assert((await disk(join(root, "newappend.txt"))) === "solo");

  // existing content is preserved (never truncated) when append: true
  await writeFileInBase(root, "app2.txt", "keep", false);
  await writeFileInBase(root, "app2.txt", " more", true);
  assert((await disk(join(root, "app2.txt"))) === "keep more");

  // append is sandboxed identically: directory + escape targets are refused
  const mDirAppend = await thrown(() => writeFileInBase(root, "subdir", "x", true));
  assert(/is a directory/.test(mDirAppend), mDirAppend);
  const mEscAppend = await thrown(() => writeFileInBase(root, "../outside.txt", "x", true));
  assert(/escapes the launch directory/.test(mEscAppend), mEscAppend);
  const mEscParentAppend = await thrown(() =>
    writeFileInBase(root, "escparent/new.txt", "x", true),
  );
  assert(/escapes the launch directory \(symlink\)/.test(mEscParentAppend), mEscParentAppend);

  console.log("PASS test5b — writeFileInBase append (extend, chunk, create, preserve, reject)");
}

// ---------------------------------------------------------------------------
// 6. fileTools(): 3 tools, names, required arrays, non-empty descriptions ----
// ---------------------------------------------------------------------------
{
  const tools = fileTools();
  assert(tools.length === 3, String(tools.length));
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  for (const n of ["read_file", "edit_file", "write_file"]) {
    assert(byName.has(n), n);
  }
  const req = (t: any) => JSON.stringify(t.function.parameters.required);
  assert(req(byName.get("read_file")!) === JSON.stringify(["path"]));
  assert(req(byName.get("edit_file")!) === JSON.stringify(["path", "search", "replace"]));
  assert(req(byName.get("write_file")!) === JSON.stringify(["path", "content"]));
  const rp = (byName.get("read_file")!.function.parameters) as any;
  assert(rp.properties.path.type === "string", "read_file.path should be a string");
  assert(rp.properties.offset.type === "integer", "read_file.offset should be an integer");
  assert(rp.properties.bytes.type === "integer", "read_file.bytes should be an integer");
  const wp = (byName.get("write_file")!.function.parameters) as any;
  assert(wp.properties.append.type === "boolean", "write_file.append should be a boolean");
  for (const t of tools) {
    assert(t.type === "function", t.function.name);
    const d = t.function.description;
    assert(typeof d === "string" && d.length > 0, t.function.name);
    assert(d.includes("launch directory"), t.function.name);
  }
  console.log("PASS test6 — fileTools() shape");
}

// ---------------------------------------------------------------------------
// 7. callFileTool: routes each name; truncated read header; unknown name +
// escaped path throw ---------------------------------------------------------
// ---------------------------------------------------------------------------
{
  await writeFile(join(root, "route.txt"), "orig\n");
  const readRes = await callFileTool(root, "read_file", { path: "route.txt" });
  assert(readRes.isError === false, JSON.stringify(readRes));
  assert(textOf(readRes).includes("orig"), textOf(readRes));

  // truncated read surfaces the byte-range header in the router text
  const readBig = await callFileTool(root, "read_file", { path: "big.txt" });
  assert(/bytes 0-65536 of 200000/.test(textOf(readBig)), textOf(readBig));

  const editRes = await callFileTool(root, "edit_file", {
    path: "route.txt",
    search: "orig",
    replace: "edited",
  });
  assert(editRes.isError === false, JSON.stringify(editRes));
  assert((await disk(join(root, "route.txt"))) === "edited\n");
  assert(textOf(editRes).includes("route.txt"), textOf(editRes));

  const writeRes = await callFileTool(root, "write_file", {
    path: "route2.txt",
    content: "fresh\n",
  });
  assert(writeRes.isError === false, JSON.stringify(writeRes));
  assert((await disk(join(root, "route2.txt"))) === "fresh\n");
  assert(textOf(writeRes).includes("route2.txt"), textOf(writeRes));

  // append routes through the router and extends the existing file
  const appRes = await callFileTool(root, "write_file", {
    path: "route2.txt",
    content: " and more\n",
    append: true,
  });
  assert(appRes.isError === false, JSON.stringify(appRes));
  assert((await disk(join(root, "route2.txt"))) === "fresh\n and more\n");
  assert(/appended/.test(textOf(appRes)), textOf(appRes));

  // unknown name -> throw (not an isError result)
  const mUnknown = await thrown(() => callFileTool(root, "no_such_tool", {}));
  assert(/unknown file tool/.test(mUnknown), mUnknown);

  // escaped path through the router -> reject
  const mEscRouter = await thrown(() =>
    callFileTool(root, "read_file", { path: "../outside.txt" }),
  );
  assert(/escapes the launch directory/.test(mEscRouter), mEscRouter);

  console.log("PASS test7 — callFileTool routing, truncated header, unknown/escape");
}

// ---------------------------------------------------------------------------
// 8. range reads (offset / bytes): correct substring, per-call cap, remaining,
//    empty/past-EOF, invalid args, range-only binary scan, router headers ----
// ---------------------------------------------------------------------------
{
  // predictable ASCII file (1 byte per char) so byte offsets == char offsets
  const pat = Array.from(
    { length: 300 },
    (_, i) => String.fromCharCode(97 + (i % 26)),
  ).join("");
  await writeFile(join(root, "range.txt"), pat, "utf8");

  // plain in-file range -> correct slice + pagination flag
  const rr = await readFileInBase(root, "range.txt", 100, 30);
  assert(rr.path === "range.txt", rr.path);
  assert(rr.content === pat.slice(100, 130), rr.content);
  assert(rr.totalBytes === 300, String(rr.totalBytes));
  assert(rr.start === 100, String(rr.start));
  assert(rr.returnedBytes === 30, String(rr.returnedBytes));
  assert(rr.truncated === true, String(rr.truncated));

  // bytes > remaining -> returns the rest, not truncated (no next page)
  const tail = await readFileInBase(root, "range.txt", 290, 50);
  assert(tail.content === pat.slice(290), tail.content);
  assert(tail.returnedBytes === 10, String(tail.returnedBytes));
  assert(tail.truncated === false, String(tail.truncated));

  // offset at file end / past EOF -> empty, nothing to read (clamped start)
  const atEnd = await readFileInBase(root, "range.txt", 300, 50);
  assert(
    atEnd.content === "" && atEnd.returnedBytes === 0 && atEnd.truncated === false,
  );
  const past = await readFileInBase(root, "range.txt", 99999, 50);
  assert(
    past.content === "" && past.returnedBytes === 0 && past.truncated === false,
    String(past.start),
  );
  assert(past.start === 300, String(past.start));

  // per-call cap: requesting >65536 bytes still returns at most 65536
  // (big.txt from test 3 = 200000 'a's)
  const capped = await readFileInBase(root, "big.txt", 1000, 999999);
  assert(capped.returnedBytes === 65536, String(capped.returnedBytes));
  assert(capped.truncated === true, String(capped.truncated));
  assert(capped.content === "a".repeat(65536), String(capped.content.length));

  // invalid offset / bytes -> actionable throws
  const mOffNeg = await thrown(() => readFileInBase(root, "range.txt", -5, 10));
  assert(/offset must be a non-negative integer byte offset/.test(mOffNeg), mOffNeg);
  const mOffNaN = await thrown(() => readFileInBase(root, "range.txt", "abc", 10));
  assert(/offset must be a non-negative integer byte offset/.test(mOffNaN), mOffNaN);
  const mBytesZero = await thrown(() => readFileInBase(root, "range.txt", 0, 0));
  assert(/bytes must be a positive integer byte count/.test(mBytesZero), mBytesZero);
  const mBytesStr = await thrown(() => readFileInBase(root, "range.txt", 0, "ten"));
  assert(/bytes must be a positive integer byte count/.test(mBytesStr), mBytesStr);

  // range-only binary scan: a NUL *inside* the requested range is rejected;
  // a NUL *outside* it is not scanned, so that range reads fine.
  const bin = Buffer.alloc(300);
  for (let i = 0; i < 300; i += 1) bin[i] = i === 50 ? 0 : 97 + (i % 26);
  await writeFile(join(root, "bin-range.txt"), bin);
  const mInRange = await thrown(() =>
    readFileInBase(root, "bin-range.txt", 40, 20),
  );
  assert(/not a plain text file \(binary content\)/.test(mInRange), mInRange);
  const okOutside = await readFileInBase(root, "bin-range.txt", 0, 20);
  assert(
    okOutside.returnedBytes === 20 && okOutside.truncated === true,
    String(okOutside.returnedBytes),
  );

  // router: a range read surfaces the byte range + "next offset" hint; an
  // empty range surfaces the "nothing to return" message.
  const rRange = await callFileTool(root, "read_file", {
    path: "range.txt",
    offset: 100,
    bytes: 30,
  });
  assert(/bytes 100-130 of 300/.test(textOf(rRange)), textOf(rRange));
  assert(/more available, next offset 130/.test(textOf(rRange)), textOf(rRange));
  const rEmpty = await callFileTool(root, "read_file", {
    path: "range.txt",
    offset: 99999,
  });
  assert(/nothing to return/.test(textOf(rEmpty)), textOf(rEmpty));

  console.log("PASS test8 — range reads (substring, cap, remaining, empty, invalid, binary)");
}

await rm(root, { recursive: true, force: true });
await rm(outside, { recursive: true, force: true });
console.log("\nALL FILE STUB TESTS PASSED");
process.exit(0);
