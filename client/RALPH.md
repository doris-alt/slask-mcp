# Running a Ralph project

A step-by-step guide to the built-in Ralph loop in `slask-client`: what you need,
which files you create or edit, how to run it (foreground, background, scheduled),
how to watch it, and how to recover when it stops. For a short overview see the
"Ralph loops" section of `README.md`.

## 1. What Ralph does

A **Ralph run** is a named list of small tasks. The loop works through them one at
a time. Each iteration is a **fresh `slask-client --prompt` process with an empty
context**; its only memory is files (`prd.json`, `progress.txt`, and git history
for code). In addition, Ralph can maintain structured learnings in `knowledge.json`
for later iterations (written by `ralph_note` when it’s prefixed).
After the worker says a task is done, the loop **verifies it itself**
before marking it passing:

| Mode       | Worker does                                   | Loop verifies with                              | Result lands in                                  |
|------------|-----------------------------------------------|-------------------------------------------------|--------------------------------------------------|
| `code`     | edits files, runs build/tests via `run_command` | your `check` command must exit 0, then commits  | the workspace itself (+ one git commit per task) |
| `research` | investigates, writes `findings/<id>.md`       | a separate fresh-context **checker** pass       | `ralph-<name>/findings/` and `ralph-<name>/report.md` |

The loop stops when all tasks pass (`done`), when one task has used `maxIterations` iterations without passing (`max-iterations`),
when one task fails verification `maxFailures` times in a row (`stuck`), or when you
stop it (`stopped`).

## 2. Requirements

- **Node.js >= 20** and a built client: `cd client && npm install && npm run build`.
  Run it as `node dist/cli.js …` or as `slask-client` if linked/installed.
- **A model endpoint** that supports OpenAI-style tool calling (set `MAX_CONTEXT_TOKENS` in `.env`
  to its context window, e.g. `131070`; default 32000):
  - real OpenAI: `OPENAI_API_KEY` set (default model `gpt-4o-mini`, change with `MODEL`/`--model`);
  - or any OpenAI-compatible server (e.g. Ollama): `API_BASE=http://host:11434`, no key needed.
  - Use a capable model. Iterations make up to 40 tool calls each; a weak model will
    fail verification repeatedly and the run ends `stuck`.
- **Code mode:** the toolchain your `check` command needs (e.g. `npm`), and **git** if you
  want commits. In a non-git workspace the check still gates tasks; the commit step is
  skipped and noted in `progress.txt`.
- **Research mode:** the client has **no built-in web search or fetch tool**. Research
  tasks can only use what an MCP server provides, plus local files. Configure an MCP
  server with search/fetch/knowledge tools in `mcp.json` (section 3), or the worker will
  have nothing to research with.
- No MCP server is required for code mode (the built-in file tools and `run_command` are enough).

## 3. Setup: files you create or edit

All paths are relative to the **workspace** = the directory the client runs in. Pick it
with `-C/--dir <path>` (any command) so you can start the client from anywhere:
`slask-client -C ~/proj ralph run api`. `.env`, `mcp.json`, `skills/`, the file tools,
`.slask-schedule.json` and `.slask-ralph/` all resolve in the workspace.

| File (in the workspace)              | You edit it? | Purpose |
|--------------------------------------|--------------|---------|
| `.env`                               | yes, once    | `OPENAI_API_KEY`, `MODEL`, `API_BASE`, `SLASK_*` settings (shell values win) |
| `mcp.json`                           | optional     | extra MCP servers (needed for research tools); copy `client/mcp.example.json` |
| `.slask-ralph/<name>/prd.json`       | yes (when stopped) | the task list: titles, criteria, priority |
| `.slask-ralph/<name>/config.json`    | yes (when stopped) | verifier and limits (below) |
| `.slask-ralph/<name>/spec.md`        | via `--spec` / `ralph spec` | the project description iterations read (a copy) |
| `.slask-ralph/<name>/progress.txt`   | rarely       | append-only learnings; you may seed the "Codebase Patterns" section with project conventions |
| `.slask-ralph/<name>/knowledge.json` | rarely       | structured learnings for code mode (written from `ralph_note` prefixes) |
| `ralph-<name>/` (research output)    | no           | deliverables written by the loop |
| `.slask-ralph/<name>/status.json`, `run.pid`, `run.log`, `iterations/`, `verdict.json` | no | loop bookkeeping and logs |

Minimal `.env`:

```sh
OPENAI_API_KEY=sk-...
MODEL=gpt-4o            # a stronger model than the default is recommended
```

### `config.json` fields

```json
{
  "mode": "code",
  "check": "npm run build && npm test",
  "commit": true,
  "maxIterations": 10,
  "timeoutS": 1800,
  "maxFailures": 3,
  "allow": ["git", "npm", "pnpm", "npx", "node", "tsc", "cargo", "python3", "make", "ls", "cat"],
  "outputDir": "ralph-<name>",
  "toolBudget": 25
}
```

- `check` (code): shell command (`sh -c`) that must exit 0. Without it the loop trusts the
  worker's claim. Set it. Make sure it fails when the work is wrong.
- `commit` (code): commit `feat: [T1] - title` after each verified task.
- `maxIterations`: max iterations **per task** (also `--max N`). The counter starts at 1 for every
  task and a pass moves on to the next task, so a run of 20 tasks needs no more than this per task,
  not 20. `ralph run` prints `iteration k/N` per task plus the overall `[run #n]` (= the `iterations/NN.log`).
- `timeoutS`: per-child timeout (worker, checker, and the `check` command).
- `maxFailures`: consecutive verification failures of one task before the run is `stuck`.
- `allow`: first words `run_command` may execute (one program per call, no shell, `&&`/`|` rejected).
  Remove `node`/`npx`/`python3` if you want it tighter; add what your project needs (`go`, `pytest`, …).
- `outputDir` (research): visible folder for findings and report; must be relative, no `..`,
  not under `.slask-ralph/`.
- `contextTokens` (optional): a per-run **cap** on the context window, in tokens (e.g.
  `ralph init x --context 16000`, or `ralph_configure`). Normally leave it out: the window comes
  from **`MAX_CONTEXT_TOKENS` in `.env`** (e.g. `MAX_CONTEXT_TOKENS=131070`), default 32000. The
  effective window is the smaller of the two, so a run never plans or reads beyond what the model
  really has. It applies to every iteration role, including the task splitter, and sizes the caps
  below. `ralph status` shows the effective value and where it came from.
- `toolBudget`: max tool calls per iteration (default 25).

### Small tasks and the context window

Every iteration starts with an empty context of only the model's window (`MAX_CONTEXT_TOKENS`), so a task has to be
small enough to finish inside it. Four mechanisms enforce that:

1. **Sizing rules in the planner.** `/ralph plan` and `--plan` tell the model the actual
   limits and require tasks with one deliverable, 2-4 criteria and at most ~3 sources/files,
   and expect 10-25 tasks for a multi-question goal, not 4-6.
2. **Lint on model-authored tasks.** `ralph_add_task` / `ralph_create` / `ralph_split_task`
   *reject* tasks with more than 4 criteria, fewer than 2, "at least 4"/"5+" of anything,
   several output files (research), or a description over 600 chars. The rejection text goes
   back to the model, which must split and retry. (`ralph add` and `--from` only warn.)
3. **Context control inside iterations.** Each tool result is truncated to ~window/4
   chars and, when the transcript nears the window, the oldest tool outputs are replaced by a
   stub. A worker that realises it can't finish calls `ralph_split_task` itself.
4. **Automatic split.** If an iteration ends without claiming the task because it ran out of
   context, tool calls or time, the loop runs a splitter pass that replaces the task with 2-4
   smaller ones (`T2` -> `T2.1`, `T2.2`; up to two levels). That is not counted as a failure.
   The splitter is deliberately boxed in: it gets only `read_file`, `grep_file`, `ralph_status` and
   `ralph_split_task` (no MCP/search/write tools), may read **only** the run's `spec.md` and `prd.json`
   (findings, reports and logs are refused), each read is capped at 8000 bytes (use `grep_file` or an
   offset slice for a big spec), and if it answers in prose or its reply is cut off it is told (max twice)
   to call `ralph_split_task` now. The research checker gets the same "call `ralph_verdict` now" nudge.
   Success is judged from the resulting task list (the task is gone and at least two replacements
   exist), never from the splitter's exit code or text. A failed split says why (the splitter's own
   rejection such as "too coarse", its crash/exit, or "never called ralph_split_task"), is logged in
   `progress.txt` as `SPLIT FAILED`, leaves the task unchanged, and shows in `ralph split`'s exit code
   (0 = split, 1 = not) and in the loop's failure reason.
   You can also trigger it by hand: `slask-client ralph split <name> <task-id>`, or in chat
   `/ralph split <name> <task-id>` (e.g. `/ralph split local-llm T2`).

Task size limits grow with the window: a task may ask for up to window/10000 items
(min 3, max 8; 131070 -> 8) before it is rejected as too coarse.

If your model keeps dying with "cut off by the token limit", lower `MAX_CONTEXT_TOKENS` / `contextTokens` (and/or
`toolBudget`) rather than raising anything: smaller budgets mean smaller tasks and shorter
tool output.

### `prd.json` shape

```json
{
  "name": "api",
  "mode": "code",
  "description": "overall goal",
  "branchName": "ralph/api",
  "tasks": [
    {
      "id": "T1",
      "title": "Add /health endpoint",
      "description": "optional detail",
      "acceptanceCriteria": ["GET /health returns 200 {\"ok\":true}", "a test covers it"],
      "priority": 1,
      "passes": false,
      "dependencies": ["T0"]
    }
  ]
}
```

Lower `priority` runs first. `passes`, `claimed`, `failures`, `lastFailure`, `notes` are
loop-managed. Only edit `prd.json` and `config.json` **while the run is not running**; the loop
rewrites `prd.json` every iteration.

## 4. Create a run

### Option A: let the model plan it (chat)

```
slask-client -C ~/proj
> /ralph plan api code Add a /health endpoint and request logging to the server
> /ralph plan survey research Compare three vector databases for our use case
```

The model drafts the tasks (for code it inspects the project and sets the `check`
command), shows you the list and waits. Review it with
`/ralph status api`; fix with `/ralph add api <title>` or by editing `prd.json`.
Asking in plain language ("plan a research run on X") works the same way.

### Option B: the CLI

```sh
slask-client -C ~/proj ralph init api --mode code --check "npm run build && npm test"
slask-client -C ~/proj ralph add api "Add /health endpoint" --criteria "GET /health returns 200;a test covers it"
slask-client -C ~/proj ralph init survey --mode research --out reports/survey
```

`--from prd.json` imports an existing task list; it accepts this client's `tasks` and
snarktank/ralph's `userStories`. `ralph init` fails if the run already exists.

### Writing good tasks (the part that decides success)

- One task = one iteration. If it needs more than a couple of sentences, split it.
- Order by dependency: add `dependencies: ["T1", "T2", ...]` to a task to make it eligible only after those prerequisite tasks pass. 2 to 5 concrete, checkable criteria per task.
- Code: make the first task create or repair the test harness if there isn't one.
- Research: one question per task; require sources and stated uncertainty in the criteria.
  Don't add a "write the report" task; the loop does a final synthesis pass itself.
- The local `ralph` skill (`skills/ralph/SKILL.md`) carries this guidance for the model.

## 4b. Describing a large project (spec file)

A one-line goal is rarely enough. Attach a **project description file** (markdown;
a PRD works well) when you create the run:

```sh
slask-client -C ~/proj ralph init shop --mode code --check "npm run build && npm test" \
    --spec tasks/prd-shop.md          # path relative to the workspace
```

- The file is **copied** to `.slask-ralph/shop/spec.md` (max 2 MB). Editing the original
  later does not change a run; replace the copy with `ralph spec shop tasks/prd-shop.md`.
- If you give no description, the run's goal is taken from the spec's first `# ` heading.
- Every iteration (worker, checker, final synthesis) is told to read the parts of the spec
  relevant to its task. The spec is **not** pasted into the prompt, so keep an overview
  (goals, non-goals, technical considerations) at the top, and have tasks name the
  sections they implement.
- Works in both modes, and together with `--from prd.json`.

**Turning the spec into tasks**

- *Interactive (chat; plain positional arguments, no `--flags`):*
  ```
  /ralph init shop code tasks/prd-shop.md     create the run with the description file
  /ralph plan shop                            the model drafts the tasks
  /ralph start shop                           after you have reviewed them
  ```
  `plan` makes the model read the spec, ask 3-5 clarifying questions with lettered options
  (answer like `1A, 2C`) if anything essential is unclear, set the `check` command (code) and
  add tasks. It shows you the list and waits; start the run yourself afterwards. Running it on
  an existing run appends tasks. Also: `/ralph spec shop <file>` replaces the description,
  `/ralph check shop npm run build && npm test` sets the code verifier by hand.
  (`/ralph plan <name> [code|research] <goal...>` creates a run from a goal alone.)
- *Headless (scripts):* add `--plan` to `init`:
  `slask-client -C ~/proj ralph init shop --spec tasks/prd-shop.md --plan`.
  One non-interactive model run drafts the task list (it cannot ask; its assumptions are
  logged in `progress.txt` as `Assumption: ...`). It never starts the run. Review with
  `ralph status shop` and edit before `ralph run`.
- *Writing the PRD itself:* the local `prd` skill (`skills/prd/SKILL.md`) interviews you
  and writes `tasks/prd-<name>.md`. Skills load from the **workspace's** `./skills/`, so
  copy `skills/prd` and `skills/ralph` into a workspace to use them there. The plan
  prompts above are built in and don't depend on the skills.

## 5. Before you start (code mode)

- **Start from a clean git tree, on a branch.** After each verified task the loop runs
  `git add -A` (scoped to the workspace) and commits. Unrelated uncommitted changes would be
  swept into those commits. Set `branchName` in `prd.json` and the loop checks it out
  (or creates it) at the start of the run.
- `.slask-ralph/` (prd, progress, status) is committed with the work, as in the original Ralph.
  `iterations/` logs and `run.*` are excluded. Add `.slask-ralph/` to `.gitignore` if you
  prefer it out of history.
- **Safety:** runs are unattended and the worker can write files in the workspace and run the
  allow-listed programs. `node`, `npx` and `python3` can execute arbitrary code, and the
  checker is told not to edit but isn't technically prevented from. Use a throwaway
  branch/clone or a container for anything you don't fully trust.

## 6. Run it

```sh
# foreground (Ctrl+C stops after killing the current iteration)
slask-client -C ~/proj ralph run api --max 10

# background (detached; log in .slask-ralph/api/run.log)
slask-client -C ~/proj ralph start api
slask-client -C ~/proj ralph stop api
```

In chat: `/ralph start api`, `/ralph stop api`, or ask the model (`ralph_start`).
Only one loop per run is allowed (a pid lock); starting a second reports the pid.

Detached runs and iteration children inherit `--model`, `--base-url`, `--config`
(and `--no-default`) from the command that launched them, and the workspace
directory. Per-iteration limits come from `MAX_CONTEXT_TOKENS` and `config.json` (`toolBudget`, optional `contextTokens`;
see above). The env vars `SLASK_MAX_TOOL_ITERATIONS`, `SLASK_MAX_TOKENS`,
`SLASK_CONTEXT_CHARS` and `SLASK_MAX_TOOL_RESULT_CHARS` override them (they also work for
normal chat, where they are off by default); `run_command` times out after 300 s
(`SLASK_RUN_COMMAND_TIMEOUT_S`).

## 7. Watch it

```sh
slask-client -C ~/proj ralph status api     # tasks, [x]/[ ], state, iteration, failures, output dir
slask-client -C ~/proj ralph list           # one line per run
tail -f ~/proj/.slask-ralph/api/run.log     # background runs
less ~/proj/.slask-ralph/api/iterations/03.log   # what iteration 3's agent did
cat ~/proj/.slask-ralph/api/progress.txt    # PASS/FAIL per task + the worker's notes
```

States: `running`, `done`, `stuck`, `max-iterations`, `stopped`. For a research run the
deliverables are in `ralph-<name>/` (`findings/T1.md`, …, `report.md`).

## 8. Scheduling

The built-in scheduler (`slask-client schedule`) fires **prompts**, not CLI commands:
each job spawns `slask-client --prompt "<text>" --quiet`. There are two ways to use it
for Ralph.

**a) Scheduler job whose prompt starts the run** (the model calls `ralph_start`):

```sh
# the daemon must run from, or be pointed at, the workspace
cd ~/proj && slask-client schedule            # keep alive (tmux/launchd/systemd)

# in another shell, same workspace:
slask-client -C ~/proj schedule add "0 2 * * *" "Start the Ralph run named nightly-audit with ralph_start, then reply with its pid."
slask-client -C ~/proj schedule add at "2026-10-21T01:30:00Z" "Start the Ralph run named api with ralph_start."
```

- The jobs file is `<workspace>/.slask-schedule.json`; the daemon re-reads it every ~15 s.
- The daemon's children inherit the **daemon's** cwd. Start the daemon with `-C ~/proj`
  (or `cd` first) so the child finds the same `.env`, `mcp.json` and `.slask-ralph/`.
- `ralph_start` returns immediately (the loop runs detached), so the scheduler job
  finishes in seconds. Check results with `ralph status`. A weak model might not call the
  tool; keep the prompt literal and check `lastStatus` with `schedule list`.
- A one-shot whose time passed while the daemon was down is **not** fired later.
- Recurring runs: a finished run has all tasks `passes: true`, so a second start does
  nothing useful. For repeated work, schedule a prompt that first adds tasks
  (`ralph_add_task`) or creates a fresh run, then starts it.

**b) Plain OS scheduling (deterministic, no model in the loop):**

```cron
0 2 * * *  cd ~/proj && /usr/local/bin/node /path/to/client/dist/cli.js ralph run nightly-audit --max 15 >> /tmp/ralph-nightly-audit.log 2>&1
```

or `slask-client -C ~/proj ralph run …`. Prefer this when the run must start reliably.

## 9. Resuming, retrying, changing course

- **Resume:** run `ralph run <name>` again. Tasks with `passes: true` are skipped; the
  the iteration counter starts again at 1 for the task it resumes on.
- **`stuck`:** read the failure at the bottom of `progress.txt` (or `lastFailure` in
  `prd.json`). Fix the cause, then rewrite or split the task (sharper criteria, smaller scope).
  Set that task's `"failures": 0` before re-running; otherwise the next failure re-sticks
  it immediately because the counter persists.
- **`max-iterations`:** one task used all its iterations without passing (the message names it). Raise
  `--max N` / `maxIterations`, or fix or split that task, then run again.
- **Stop mid-run:** `ralph stop <name>` / Ctrl+C. The in-flight iteration is killed and its
  task stays unverified (retried on the next run).
- **Add or reorder tasks:** `ralph add`, or edit `prd.json` while stopped.
- **Start over:** delete `.slask-ralph/<name>/` (and `ralph-<name>/` for research), then
  `init` again. There is no archive step; copy the folder first if you want to keep it.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| every iteration: "worker ended … without calling ralph_complete_task — last output: …" | the reason now ends with the child's last output line. Usually the task is too big: it is split automatically, or run `ralph split <name> <id>`; set `MAX_CONTEXT_TOKENS` in `.env` to your model's real window; otherwise the model is too weak |
| "the response was cut off by the token limit" | the context window filled up, or a single reply hit `max_tokens` (about window/8, 1k-16k; thinking models spend it before the tool call; roles that must end with a tool call are nudged instead of failing): lower `MAX_CONTEXT_TOKENS` to what the server really allows (and/or `toolBudget`), and make tasks smaller |
| planner keeps getting "too coarse for one iteration" | working as intended: it must split the task; if it loops, plan with a stronger model or add tasks by hand (`ralph add`, which only warns) |
| `check … failed` repeatedly | the check really fails or needs tooling the machine lacks; run it by hand in the workspace |
| `command "x" is not allowed` | add the program to `allow` in `config.json` |
| `there is no shell` | the model tried `&&`/`|`; it must issue one command per `run_command` call (the loop's own `check` is run through a shell and may chain) |
| `already running (pid …)` | another loop holds the run; `ralph stop <name>` (a pid file of a dead process is ignored automatically) |
| research findings thin / invented | no MCP search/fetch tool is configured; add one to `mcp.json` and tighten the criteria (sources required) |
| scheduler job ran but nothing happened | wrong cwd for the daemon (`-C`), or the model did not call `ralph_start`; check `schedule list` and `.slask-ralph/<name>/run.log` |
| `OPENAI_API_KEY is not set` | set it in the workspace `.env` or the shell, or point `API_BASE` at a local server |
| MCP server unreachable warning | non-fatal; built-in tools still work, but research needs its tools |

## 10b. Patching a finished run (add a task, redo one task, redo the report)

You do not have to restart a run to change its result. The loop skips every task with
`passes: true`, so a re-run only does the new or re-opened work. For a research run it then
repeats the final synthesis, which rewrites `report.md` from all findings (the previous
report is kept as `report.prev.md`).

Example: the report left out a comparison, run `local-llm` in `xx/`:

```text
# 1. add the missing task (a run in state "done" accepts new tasks)
slask-client -C xx ralph add local-llm "Compare the Mac mini M6" \
  --criteria "ralph-local-llm/findings/mac-mini-m6.md exists;cites at least 2 recent sources;states whether it changes the top-line pick" \
  --desc "Compare the Mac mini M6 against the table in ralph-local-llm/findings/hardware-tradeoff.md: price, memory, bandwidth, tokens/sec. Write findings/mac-mini-m6.md."
# 2. run: only the new task, its checker, and the report run
slask-client -C xx ralph start local-llm
```

- **Redo a task that passed but was weak:** `ralph reopen <name> <task-id> [--note "what was missing"]`
  (chat: `/ralph reopen <name> <task-id>`), then `ralph start <name>`. The note is shown to the
  worker as the last failure. Its old findings file stays in place for it to improve.
- **Redo only the report:** `ralph report <name>` (chat: `/ralph report <name>`). Needs a research run
  whose tasks all pass. `ralph start <name>` on a finished run does the same.
- Keep tasks small (see "Small tasks and the context window"): new tasks go through the same lint.
- The synthesis reads `findings/` and `progress.txt`, so old conclusions can anchor it. Put "state
  whether this changes the top-line recommendation" in the new task's criteria so the report has
  something explicit to pick up.
- In code mode `reopen` re-runs the task and the `check` command; `report` does not apply.

## 11. Quick reference

```text
slask-client [-C <dir>] ralph init <name> [--mode code|research] [--check <cmd>] [--from prd.json] [--spec <file> [--plan]] [--out <dir>] [--max N] [--context <tokens>] [--tool-budget <n>]
slask-client [-C <dir>] ralph spec <name> <file>        replace the project description
slask-client [-C <dir>] ralph add <name> <title> [--criteria "a;b;c"] [--desc <text>]     (warns if the task looks too coarse)
slask-client [-C <dir>] ralph reopen <name> <task-id> [--note <why>]   run a passed task again
slask-client [-C <dir>] ralph report <name>             research: rewrite report.md only
slask-client [-C <dir>] ralph split <name> <task-id>    have the model replace a too-big task with 2-4 smaller ones
slask-client [-C <dir>] ralph run <name> [--max N]      foreground
slask-client [-C <dir>] ralph start|stop <name>         background
slask-client [-C <dir>] ralph status [name] | list
chat:   /ralph list | status <n> | init <n> [mode] [spec-file] | spec <n> <file> | check <n> <cmd...>
                | plan <n> [mode] [goal...] | add <n> <title...> | split <n> <task-id> | reopen <n> <task-id> | report <n> | start <n> | stop <n>   (positional; flags are CLI-only)
tools:  ralph_list ralph_status ralph_create ralph_add_task ralph_configure ralph_note ralph_start ralph_stop   (chat)
        ralph_status ralph_add_task ralph_note ralph_complete_task ralph_split_task run_command                  (worker iterations)
        ralph_status ralph_verdict                                                                              (research checker)
        ralph_status ralph_split_task                                                                           (splitter pass)
        (ralph_add_task / ralph_create / ralph_split_task reject tasks that are too coarse)
config: .slask-ralph/<name>/config.json: check commit maxIterations timeoutS maxFailures allow outputDir toolBudget [contextTokens = optional cap]
env:    MAX_CONTEXT_TOKENS (model context window, default 32000; in .env)
        SLASK_MAX_TOOL_ITERATIONS, SLASK_MAX_TOKENS, SLASK_CONTEXT_CHARS, SLASK_MAX_TOOL_RESULT_CHARS
          (in runs: derived from toolBudget and the effective window; env overrides)
        SLASK_RUN_COMMAND_TIMEOUT_S (300)  SLASK_SCHEDULE_TIMEOUT_S (1800)  SLASK_SCHEDULE_POLL_S (15)
```
