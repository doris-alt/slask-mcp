---
name: ralph
description: How to write a good Ralph task list (small, verifiable tasks) for coding or research runs. Use before calling ralph_create or when the user asks to plan an autonomous / overnight / long-running task.
---

A Ralph run works through a task list, one fresh-context iteration per task.
An iteration remembers nothing except `progress.txt`, `prd.json` and git, so the
quality of the task list decides the outcome.

## Large projects: use a spec file
A one-line goal is not enough for a big project. Write a project description
(the `prd` skill produces one: `tasks/prd-<name>.md`) and attach it:
`slask-client ralph init <name> --spec <file> [--plan]` (shell) or, in chat,
`/ralph init <name> code <file>` then `/ralph plan <name>`.
The file is copied to `.slask-ralph/<name>/spec.md` and every iteration reads the
parts relevant to its task. Give each task a description that names the spec
sections it implements, so iterations don't re-read everything.

## Task size is a hard limit
Each iteration has only a small context (`contextTokens`, default 32000 tokens) and a tool
budget (default 25 calls). A multi-question goal usually needs 10-25 tasks, not 4-6. One task =
one output file, 2-4 criteria, at most ~3 sources/pages/files. Split per question and per
option/source group; give each comparison or summary its own task that reads the earlier
findings. Oversized tasks are rejected by `ralph_add_task`/`ralph_create`.

## Splitting the goal
- One task = one iteration. If you cannot describe it in two sentences, split it.
- Order by dependency: schema before API before UI; survey before comparison.
- Every task needs 2-5 acceptance criteria a stranger could check. Avoid "works
  well" / "is comprehensive". Prefer "`npm test` passes and covers the empty-list
  case" / "names at least 3 vendors, each with a cited source".

## Code runs (`mode: code`)
- Inspect the project first (package.json, Makefile, README) and set `check` to
  the real build + test command, e.g. `npm run build && npm test`. A task only
  passes when `check` exits 0; the loop then commits it.
- Add a first task to create/repair the test harness if there is none.
- UI tasks: include a criterion that can be verified by a command, not by eye.

## Research runs (`mode: research`)
- Each task is one question. The worker writes `findings/<id>.md`; a separate
  checker judges it against the criteria, so require sources and explicit
  statements of uncertainty in the criteria.
- Findings and the final report are written to the run's visible output folder
  (default `ralph-<name>/`, set `outputDir`); `.slask-ralph/` is internal state.
- Finish with the loop's automatic synthesis step (`report.md`); do not add a
  "write the report" task yourself.

## Running
`ralph_create` -> show the user the list -> wait for approval -> `ralph_start`
-> report with `ralph_status`. A task that fails 3 times in a row stops the run:
look at `progress.txt` for the failure reason and rewrite the task.
