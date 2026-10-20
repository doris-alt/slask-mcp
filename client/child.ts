// child.ts — spawn this CLI as a one-shot child (fresh process, fresh context).
//
// Shared by the scheduler daemon (schedule.ts: one child per firing) and the
// Ralph loop (ralph.ts: one child per iteration). argv[1] is the running entry
// file, so the child is the identical binary + path, with the same cwd. There
// is no shell, so prompts are never interpreted as shell input.

import { spawn } from "node:child_process";

export type ChildProcess = ReturnType<typeof spawn>;

export const SIGKILL_GRACE_MS = 5_000; // SIGTERM → SIGKILL gap

export interface RunCliChildOptions {
  /** Kill the child (SIGTERM, then SIGKILL) after this long. */
  timeoutMs: number;
  /** Extra env vars merged over this process's env. */
  env?: Record<string, string>;
  /** Pipe the child's stdout/stderr (returned in `output`) instead of inheriting. */
  capture?: boolean;
  /** Called with each captured chunk (only with `capture`). */
  onOutput?: (chunk: string) => void;
  /** Called once with the spawned child (so a caller can kill it on shutdown). */
  onSpawn?: (child: ChildProcess) => void;
}

/**
 * Run `<node> <argv[1]> ...args` and resolve with an effective exit code:
 * 0 = ok, -1 = timed out (or killed by a signal), -2 = failed to start,
 * >0 = the child's own non-zero exit code. `output` is the captured
 * stdout+stderr ("" unless `capture`).
 */
export function runCliChild(
  args: string[],
  opts: RunCliChildOptions,
): Promise<{ code: number; output: string }> {
  const child = spawn(process.execPath, [process.argv[1] ?? "", ...args], {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
  opts.onSpawn?.(child);
  return new Promise((resolve) => {
    let done = false;
    let output = "";
    let killTimer: NodeJS.Timeout | undefined;
    if (opts.capture) {
      const sink = (b: Buffer) => {
        const s = b.toString("utf8");
        output += s;
        opts.onOutput?.(s);
      };
      child.stdout?.on("data", sink);
      child.stderr?.on("data", sink);
    }
    const clearKill = () => {
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, output });
    };
    // On timeout: SIGTERM, then SIGKILL if the child is still alive.
    const timeoutTimer = setTimeout(() => {
      if (done) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(-1);
      }, SIGKILL_GRACE_MS);
    }, opts.timeoutMs);
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
