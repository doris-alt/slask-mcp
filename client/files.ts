// files.ts — the client's built-in file tools: `read_file`, `edit_file`,
// `write_file`.
//
// All paths are resolved relative to the launch directory (the cwd where
// `slask-client` started). Access is hard-sandboxed in client code — not by
// the agent, not by the model. The guard has two layers:
//
//   1. string level — the resolved path must equal the base or lie directly
//      under it; absolute paths and `..` climbs (of any depth) are rejected
//      before any filesystem operation.
//   2. symlink level — for existing targets, the real path (all symlinks
//      resolved) must be contained in the base's real path, so a link named
//      inside the launch directory that points outside is also rejected.
//
// Every failure throws an `Error` with a message the model can act on;
// `runAgentTurn` (agent.ts) feeds any throw back into the conversation as
// `ERROR calling <name>: <message>`, so a refused path is a recoverable step,
// not a crash.

import {
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import type { CallToolResult, OpenAiFunctionTool } from "./types.js";

/** Names of the built-in file tools (reused by the UI banner and docs). */
export const FILE_TOOL_NAMES: string[] = ["read_file", "edit_file", "write_file"];

/**
 * Max bytes returned by `read_file`. Larger files are truncated to this limit
 * (with a marker) so one tool result can't bloat context — the same
 * "lean for small models" reasoning as the skill bundle caps in skills.ts.
 */
const MAX_READ_BYTES = 65536;

/**
 * Hard cap on files that `edit_file` may touch: the full content is loaded
 * into memory for the search-and-replace. `write_file` is uncapped — the
 * model's own per-completion token limit bounds what it can emit anyway.
 */
const MAX_EDIT_BYTES = 10_485_760; // 10 MiB

/** Plain text = no NUL bytes (same heuristic as skills.ts `isText`). */
function isText(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0) return false;
  return true;
}

/** Model-facing path: `abs` expressed relative to the (resolved) base dir. */
function relOf(baseDir: string, abs: string): string {
  const rel = relative(resolve(baseDir), abs);
  return rel === "" ? "." : rel;
}

/**
 * Layer 1 of the sandbox (string level). Coerces the raw path to a trimmed
 * string, rejects empty and absolute paths, and requires the path resolved
 * against `baseDir` to equal the base or lie directly under it — a single
 * uniform check that also rejects `..` climbs of any depth (e.g.
 * `a/../../etc/passwd`). Throws a model-actionable error otherwise.
 */
export function resolveInBase(baseDir: string, rawPath: unknown): string {
  const raw = String(rawPath ?? "").trim();
  if (raw === "") {
    throw new Error("path must not be empty");
  }
  if (isAbsolute(raw)) {
    throw new Error(
      "absolute paths are not allowed — use a path relative to the launch directory",
    );
  }
  const abs = resolve(baseDir, raw);
  const base = resolve(baseDir);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error("path escapes the launch directory: " + raw);
  }
  return abs;
}

/**
 * Layer 2 of the sandbox (symlink level). If `absPath` exists, its real path
 * (all symlinks resolved) must be contained in the base's real path — this
 * is what rejects a link *named inside* the launch directory that points
 * outside. If `absPath` does not exist yet there is nothing to follow, so
 * only layer 1 applies (already applied by the caller). Throws on escape;
 * returns the best-known physical path (the logical path when the path
 * doesn't exist yet — used as the mkdir target for write_file).
 */
export async function resolveExistingInBase(
  baseDir: string,
  absPath: string,
): Promise<string> {
  const realBase = await realpath(baseDir).catch(() => baseDir);
  const real = await realpath(absPath).catch(() => null);
  if (real !== null && real !== realBase && !real.startsWith(realBase + sep)) {
    throw new Error("path escapes the launch directory (symlink): " + absPath);
  }
  return real ?? absPath;
}

// ---------------------------------------------------------------------------
// operations (each throws model-actionable Errors)
// ---------------------------------------------------------------------------

function parseOffset(value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(
      "offset must be a non-negative integer byte offset (got " +
        JSON.stringify(value) + ")",
    );
  }
  return n;
}

function parseBytes(value: unknown): number {
  if (value === undefined || value === null) {
    return MAX_READ_BYTES;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
    throw new Error(
      "bytes must be a positive integer byte count (got " +
        JSON.stringify(value) + ")",
    );
  }
  return n;
}

export interface FileReadResult {
  path: string;
  content: string;
  totalBytes: number;
  start: number;
  returnedBytes: number;
  truncated: boolean;
}

/**
 * Read a plain-text file inside the sandbox. Throws on missing or directory
 * targets, binary content, or sandbox escapes. Only the requested byte range is
 * ever loaded off disk (seek + chunked read), so arbitrarily large files can be
 * read in bounded pages.
 *
 * `rawOffset` (0-based byte offset, default 0) and `rawBytes` (byte count, default
 * `MAX_READ_BYTES`) select the range; the returned bytes are always capped at
 * `MAX_READ_BYTES`.
 */
export async function readFileInBase(
  baseDir: string,
  rawPath: unknown,
  rawOffset?: unknown,
  rawBytes?: unknown,
): Promise<FileReadResult> {
  const abs = resolveInBase(baseDir, rawPath);
  const rel = relOf(baseDir, abs);
  const st = await stat(abs).catch(() => {
    throw new Error("no such file: " + rel);
  });
  if (st.isDirectory()) {
    throw new Error(rel + " is a directory");
  }
  await resolveExistingInBase(baseDir, abs);

  const size = st.size;
  const offset = parseOffset(rawOffset);
  const bytes = parseBytes(rawBytes);

  const start = Math.min(offset, size);
  const available = size - start;
  if (size === 0 || available === 0) {
    return {
      path: rel,
      content: "",
      totalBytes: size,
      start,
      returnedBytes: 0,
      truncated: false,
    };
  }

  const readLen = Math.min(bytes, available, MAX_READ_BYTES);
  const fd = await open(abs, "r");
  try {
    const chunks: Buffer[] = [];
    let pos = start;
    const end = start + readLen;
    while (pos < end) {
      let buf = Buffer.alloc(end - pos);
      // Absolute-position read: `position` is an integer byte offset (pread
      // semantics), so the file's own cursor is left unchanged and each
      // iteration is independent of the previous one.
      const r = await fd.read(buf, { position: pos });
      if (r.bytesRead === 0) break;
      if (r.bytesRead < buf.length) buf = buf.subarray(0, r.bytesRead);
      chunks.push(buf);
      pos += r.bytesRead;
    }
    const buf = Buffer.concat(chunks);
    if (buf.length > 0 && !isText(buf)) {
      throw new Error(rel + " is not a plain text file (binary content)");
    }
    return {
      path: rel,
      content: buf.toString("utf8"),
      totalBytes: size,
      start,
      returnedBytes: pos - start,
      truncated: pos < size,
    };
  } finally {
    await fd.close();
  }
}

export interface FileEditResult {
  path: string;
  matched: number;
}

/**
 * Atomic search-and-replace edit of a text file inside the sandbox — the
 * "read — edit in memory — write it back" workflow, done in one client step:
 * the file is only rewritten when the edit succeeds. `replace` of the empty
 * string deletes the match.
 */
export async function editFileInBase(
  baseDir: string,
  rawPath: unknown,
  rawSearch: unknown,
  rawReplace: unknown,
  rawReplaceAll: unknown,
): Promise<FileEditResult> {
  const abs = resolveInBase(baseDir, rawPath);
  const rel = relOf(baseDir, abs);
  const search = String(rawSearch ?? "");
  if (search === "") {
    throw new Error("search must be a non-empty string");
  }
  const st = await stat(abs).catch(() => {
    throw new Error("no such file: " + rel);
  });
  if (st.isDirectory()) {
    throw new Error(rel + " is a directory");
  }
  await resolveExistingInBase(baseDir, abs);
  if (st.size > MAX_EDIT_BYTES) {
    throw new Error(
      "file is too large to edit: " + st.size + " bytes (limit " + MAX_EDIT_BYTES + ")",
    );
  }
  const replace = String(rawReplace ?? "");
  const content = await readFile(abs, "utf8").catch(() => {
    throw new Error("could not read " + rel);
  });
  const matches = content.split(search).length - 1;
  if (matches === 0) {
    throw new Error("no match for the search string in " + rel);
  }
  if (matches > 1 && !Boolean(rawReplaceAll)) {
    throw new Error(
      "the search string matches " + matches + " times in " + rel +
        " — make the search more specific, or pass replaceAll: true to change every occurrence",
    );
  }
  const next = Boolean(rawReplaceAll)
    ? content.split(search).join(replace)
    : content.replace(search, replace);
  await writeFile(abs, next, "utf8");
  return { path: rel, matched: matches };
}

export interface FileWriteResult {
  path: string;
  bytes: number;
  created: boolean;
  appended: boolean;
}

/**
 * Create, overwrite, or append to a plain-text file inside the sandbox. Parent
 * directories are created as needed (all of them stay inside the base by
 * construction). Refuses to target an existing directory or the launch
 * directory itself.
 *
 * `append` false (default): create or fully overwrite (truncating) — use for
 * new files or full rewrites. `append` true: add the text to the end of the
 * file, creating it if it does not yet exist — the chunked-write path, where
 * you start the file once with `append` false and send each following chunk
 * with `append` true.
 */
export async function writeFileInBase(
  baseDir: string,
  rawPath: unknown,
  rawContent: unknown,
  rawAppend?: unknown,
): Promise<FileWriteResult> {
  const abs = resolveInBase(baseDir, rawPath);
  const rel = relOf(baseDir, abs);
  if (resolve(baseDir) === abs) {
    throw new Error("the launch directory itself is not a writable file target");
  }
  if (rawContent === undefined || rawContent === null) {
    throw new Error("content is required");
  }
  const content = String(rawContent);
  const append = Boolean(rawAppend);

  const st = await stat(abs).catch(() => null);
  if (st !== null && st.isDirectory()) {
    throw new Error(rel + " is a directory");
  }
  // A write target that is a symlink must itself stay inside the base
  // (writing follows symlinks). Existing-parent symlinks that point outside
  // are caught by the realpath check below.
  await resolveExistingInBase(baseDir, abs);
  const realParent = await resolveExistingInBase(baseDir, dirname(abs));
  await mkdir(realParent, { recursive: true });
  if (append) {
    await appendFile(abs, content, "utf8");
  } else {
    await writeFile(abs, content, "utf8");
  }
  return {
    path: rel,
    bytes: Buffer.byteLength(content, "utf8"),
    created: st === null,
    appended: append,
  };
}

// ---------------------------------------------------------------------------
// tool definitions + router
// ---------------------------------------------------------------------------

/**
 * The OpenAI function-calling definitions for the file tools. Every
 * description states the sandbox rule explicitly so the model self-corrects
 * (relative paths only) instead of burning tool iterations on rejected calls.
 */
export function fileTools(): OpenAiFunctionTool[] {
  const note =
    "Paths are relative to the launch directory and may not leave it: " +
    "`..` climbs, absolute paths, and symlink escapes are rejected by the client.";

  return [
    {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a plain-text file under the launch directory and return its " +
          "content plus the byte range that was returned. Use `offset` (0-based " +
          "byte start) and `bytes` (byte count) to read an arbitrary byte range of " +
          "a large file and paginate: each read is capped at 65536 bytes and the " +
          "result reports the `next offset` to continue from. " +
          note +
          " Binary content (NUL bytes in the returned range) is rejected. Byte " +
          "reads are byte-oriented: a boundary that splits a multi-byte UTF-8 " +
          "character renders as a replacement character — nudge `offset` a byte " +
          "or two for clean boundaries.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "relative path to the file (e.g. 'notes.txt' or 'src/utils.ts')",
            },
            offset: {
              type: "integer",
              description: "0-based byte offset to start reading from (default: 0)",
            },
            bytes: {
              type: "integer",
              description:
                "number of bytes to read from `offset` (default: 65536, the per-read cap)",
            },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Search-and-replace edit of a text file under the launch directory: " +
          "the file is read, the replacement is applied in memory, and it is " +
          "written back in one atomic step — it is never modified unless the " +
          "edit succeeds. The search string must match exactly once, or pass " +
          "replaceAll to change every occurrence. `replace` may be the empty " +
          "string to delete a match. " + note,
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "relative path to the file" },
            search: {
              type: "string",
              description: "exact substring to find (case-sensitive)",
            },
            replace: {
              type: "string",
              description: "replacement text (empty string deletes the match)",
            },
            replaceAll: {
              type: "boolean",
              description:
                "replace every occurrence, not just the first (default: false)",
            },
          },
          required: ["path", "search", "replace"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Create, overwrite, or append to a plain-text file under the launch " +
          "directory; parent directories are created as needed. With `append` " +
          "false (the default) the file is created or fully overwritten — use " +
          "for new files or full rewrites. With `append` true the text is added " +
          "to the end of the file (creating it if it does not yet exist) — use " +
          "this to write a large file in chunks: one `write_file` call per " +
          "chunk, the first with `append` false and each following chunk with " +
          "`append` true. For targeted changes to an existing file prefer " +
          "edit_file. " + note,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "relative path of the file to create, overwrite, or append to",
            },
            content: { type: "string", description: "text to write to the file" },
            append: {
              type: "boolean",
              description:
                "when true, append `content` to the end of the file instead of " +
                "overwriting it (the file is created if it does not exist). " +
                "Default: false.",
            },
          },
          required: ["path", "content"],
        },
      },
    },
  ];
}

/** System-prompt paragraph for the file tools (tools are always available). */
export function fileSystemBlock(): string {
  return (
    "\n\nFile access: you have built-in file tools — `read_file` (inspect a " +
    "text file, optionally a byte range via `offset` and `bytes`), `edit_file` " +
    "(atomic search-and-replace), and `write_file` (create or overwrite a file, " +
    "or append to it with `append: true`; parent directories are created as " +
    "needed). They are sandboxed to the directory you were launched in and its " +
    "subdirectories; any path that would leave it (absolute, `..`, or symlink) " +
    "is rejected by the client. To write a large file in chunks, call " +
    "`write_file` once to start the file (the default overwrite is fine for the " +
    "first chunk), then send each further chunk with `append: true`. To read a " +
    "large file, use `read_file` byte ranges and continue from the `next " +
    "offset` the result reports. Use `edit_file` for targeted changes."
  );
}

/**
 * Router used by the agent loop: dispatches a named file tool to its
 * implementation and wraps the outcome in MCP's `CallToolResult` shape.
 * Unknown names, path escapes, and file errors throw — `runAgentTurn` feeds
 * any throw back to the model as `ERROR calling <name>: <message>`.
 */
export async function callFileTool(
  baseDir: string,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  let text: string;
  switch (name) {
    case "read_file": {
      const r = await readFileInBase(
        baseDir,
        args.path,
        args.offset,
        args.bytes,
      );
      let header =
        r.path + ": " + r.totalBytes + " byte" + (r.totalBytes === 1 ? "" : "s");
      if (r.returnedBytes === 0) {
        header +=
          " — nothing to return (offset " +
          r.start +
          " is at or past the file's end)";
      } else {
        const end = r.start + r.returnedBytes;
        const range =
          "(bytes " + r.start + "-" + end + " of " + r.totalBytes + ")";
        if (r.truncated) {
          header += " " + range + "; more available, next offset " + end;
        } else if (r.start > 0) {
          header += " " + range;
        }
      }
      text = r.content === "" ? header : header + "\n" + r.content;
      break;
    }
    case "edit_file": {
      const r = await editFileInBase(
        baseDir,
        args.path,
        args.search,
        args.replace,
        args.replaceAll,
      );
      text =
        "edited " + r.path + ": replaced " + r.matched + " occurrence(s)";
      break;
    }
    case "write_file": {
      const r = await writeFileInBase(baseDir, args.path, args.content, args.append);
      text =
        r.appended
          ? "appended " + r.bytes + " bytes to " + r.path + (r.created ? " (new file)" : "")
          : "wrote " + r.bytes + " bytes to " + r.path + (r.created ? " (new file)" : "");
      break;
    }
    default:
      throw new Error("unknown file tool " + JSON.stringify(name));
  }
  return { isError: false, content: [{ type: "text", text }] };
}
