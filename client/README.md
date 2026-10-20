# slask-mcp-client

A Node.js CLI that makes MCP servers usable by a language model. Point it at
the slask server — or at any number of your own stdio and HTTP MCP servers —
and drive the tools it exposes either interactively (an agent chat using OpenAI
function-calling) or by hand (`list` / `call`).

## Usage

The client is a **TypeScript** Node.js ESM CLI (`"type": "module"`, Node v20+
required) that talks to MCP servers over streamable HTTP or raw stdio. The
source lives in `client/*.ts`; the runnable program is the compiled
`client/dist/` — so the build must be (re)done before running.

### Build

Prerequisite: Node.js v20+ with `npm`.

```bash
cd client
npm install
npm run build
```

`npm run build` compiles every `.ts` file to `client/dist/*.js`. The
`slask-client` binary is `dist/cli.js` (the `bin` entry in `package.json`).
Re-run it after every source change.

```bash
npm run typecheck   # type-checks without emitting anything
npm run clean       # deletes dist/ (then rebuild)
```

(Optional) To put `slask-client` on your `PATH` from any directory, run `npm
link` once from `client/` — it symlinks this package into npm's global
prefix, so `slask-client …` works from any terminal. Because it's a symlink,
the global command always executes the latest `dist/` build — after a source
change, re-run `npm run build`, but you never need to re-link. Undo with `npm
unlink` (from `client/`). If you only ever run from inside `client/`, skip
this — `npx slask-client …` already covers it.

### Run

After a build, three equivalent ways to launch the CLI — all of them run
`client/dist/cli.js`:

| Way | Command | When |
|-----|---------|------|
| `npx` (recommended) | `npx slask-client list` | From inside `client/`; resolves the local package's `bin` entry, nothing to install |
| Direct | `node dist/cli.js list` | Always works once built; no npm resolution step |
| Global | `npm link` in `client/`, then `slask-client list` | Puts `slask-client` on your `PATH` from anywhere |

`slask-client help` (or `--help`) prints the full command reference.

Typical first run, once the slask server is up (see **Configure** below):

```bash
npx slask-client list                        # can the client see the tools?
npx slask-client call echo --message hello
```

### Configure

For agent chat, configure the model via a `.env` file in the current working
directory (copy `client/.env.example` to `./.env` first — it lists
`SLASK_MCP_URL`, `API_BASE`, `MODEL`, `OPENAI_API_KEY`), env vars, or
flags; shell env wins over the file; every setting is covered in the
**Options & environment** section below.

#### Start the server

Run the slask-mcp server on the same machine (or on any host reachable by URL). Default bind: `127.0.0.1:8000`, default path: `/mcp`. The server is HTTP with optional Bearer-token auth:

```
# no auth (default)
slask-mcp

# with Bearer auth
SLASK_MCP_TOKEN=my-secret slask-mcp
```

#### Multiple servers (configuration file)

The slask server is configured with `--url`/`--token` (or `SLASK_MCP_URL`/
`SLASK_MCP_TOKEN`) and is always connected — named **`slask`** — in
addition to any servers you list in a JSON config file. There is **no fixed
limit** on how many you can add; each entry is a complete, self-contained
spec.

The default config path is `mcp.json` in the current working directory (where
`slask-client` is launched). Override it with `--config`/`-c` or the
`SLASK_MCP_CONFIG` env var. A missing *default* file simply means "no extra
servers"; a missing *explicitly* given file is an error. Copy
`client/mcp.example.json` to `mcp.json` in your current directory to get
started:

```json
{
  "servers": [
    {
      "name": "weather",
      "type": "stdio",
      "command": "/path/to/weather-mcp",
      "args": ["--verbose"],
      "env": {"WEATHER_API_KEY": ""}
    },
    {
      "name": "calendar",
      "type": "http",
      "url": "http://127.0.0.1:9001/mcp",
      "token": "secret"
    }
  ]
}
```


| Field          | HTTP           | stdio           | Notes                                                             |
|----------------|----------------|-----------------|-------------------------------------------------------------------|
| `name`         | required       | required        | unique; must not contain a space or `__` (reserved for collisions)|
| `type`         | http or stdio  | http or stdio   | connection kind                                                   |
| `url`          | required (http)| ignored         | full endpoint including `/mcp`                                    |
| `token`        | optional (http)| ignored         | bearer token; sent as `Authorization: Bearer ...`                 |
| `command`      | ignored        | required (stdio)| executable path to run as the server process                      |
| `args`         | ignored        | optional (stdio)| command-line arguments passed to the process                      |
| `env`          | ignored        | optional (stdio)| extra environment variables for the process                       |
| `cwd`          | ignored        | optional (stdio)| working directory for the stdio process (default: current dir)    |
| `stderr`       | ignored        | optional (stdio)| child stderr: `"inherit"`, `"pipe"`, `"ignore"`, or `"overlapped"` (default: `"inherit"`; mirrors Node `spawn` `stdio`) |
| `maxBufferSize`| ignored        | optional (stdio)| max bytes of buffered stdio output per read (default: 10 MiB)     |


**Tool naming and collisions.** Every tool from every connected server is listed once in the
OpenAI function-calling `tools` array. A tool whose name is unique across all connected
servers is exposed under its raw name. When two or more servers expose a tool with the
same raw name, each occurrence is namespaced as `<serverName>__<toolName>` (e.g.
`weather__forecast`, `calendar__forecast`), and the client routes each call back to the
server it came from. The model sees only the namespaced names, so there is no ambiguity.

**Best-effort connect.** Each server is connected independently. A server that fails to
connect (bad URL, token, command not found, timeout) is reported on stderr with a hint
and then skipped; the other servers keep working. No reachable — or even absent — server
is *not* fatal: with zero reachable MCP servers the client still starts and offers its
built-in file/schedule tools and local skills, so it always launches. Per-server
warnings are printed once on stderr, before the command runs.

## Interactive agent chat

Run with no subcommand (or `chat`):

```
# local OpenAI-compatible model (e.g. Ollama), no API key needed
SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 MODEL=gemma4:12b-mlx slask-client

# real OpenAI (needs OPENAI_API_KEY; API_BASE defaults to https://api.openai.com/v1)
OPENAI_API_KEY=sk-… SLASK_MCP_URL=http://127.0.0.1:9000/mcp slask-client
```

On startup the client shows a banner listing every connected server (name, kind,
address), the model, and the full set of tools. Then it drops into a line-based REPL:

```
slask-agent > what time is it now?
  ▸ current_time_utc({})
      2026-10-01T00:00:00Z
  The UTC time is 2026-10-01T00:00:00Z.

slask-agent >
```

### REPL commands

| Command   | What it does                                  |
|-----------|-----------------------------------------------|
| /help     | show REPL help                                |
| /tools    | list all tools (across every connected server)|
| /skills   | list local skills (./skills/)                 |
| /reset    | clear the conversation history                |
| /compact  | summarize the conversation, reclaiming context|
| /schedule | manage scheduled jobs (`add` / `list` / `rm`) |
| /quit     | exit the REPL (or /exit, /q, Ctrl+C)          |

### One-shot prompts

To run a single prompt without the REPL, pass `--prompt` (or `-p`). The client
connects, runs one agent turn with your prompt, prints the answer (with the same
tool trace), and exits:

```bash
SLASK_MCP_URL=http://127.0.0.1:9000/mcp API_BASE=http://192.168.68.73:11434 \
  MODEL=gemma4:12b-mlx slask-client --prompt "use news-feeds to pull news from BBC"
```

This is the deterministic way to run one turn for scripting, cron, or CI —
`echo "…" | slask-client` is not reliable, because a closed stdin makes the
REPL shut down before the model answers.

## Direct, non-LLM commands

Run a tool without the agent:

```
# list every tool (across every connected server) with its input schema
slask-client list

# call a tool directly
slask-client call echo --message hello
slask-client call current_time_utc
slask-client call search_tools --query echo
slask-client call echo --args '{"message": "hi"}'
```

Warnings about unreachable servers are printed to stderr; the exit code is 1 on failure.

## Skills

The client also picks up **skills**: directories under `./skills/` (the
directory where `slask-client` was launched) containing a `SKILL.md` file —
the same convention Claude Code uses for skills, so skills copied from
`~/.claude/skills/` drop in unchanged.

`SKILL.md` may start with an optional YAML frontmatter block:

    ---
    name: my-skill      # optional — defaults to the directory name
    description: …      # one-liner the model reads to decide when to use it
    disabled: true      # optional — skip this skill entirely
    ---

followed by the full markdown instructions (the skill's *body*). Only `name`
and `description` are ever put in the model's context at startup (they are
shown in the banner and under "Available skills" in the system prompt). When
the task looks like it matches a description, the agent calls the `invoke_skill`
tool with the skill name; only then is the full body sent to the model, plus
the *names* of the skill's other text files (relative to the `SKILL.md`, e.g.
`references/notes.md`). The model then loads any one of those files' content on
demand by passing its `file` argument — the same "when explicitly needed" lazy
loading the [skill spec](https://www.skillsdirectory.com/docs/skill-file-structure)
describes. That keeps context lean for small local models: each reference is
capped at 16 KiB and the returned text at 32 KiB per call.

A skill directory may also contain a **`scripts/`** folder; the files there
ending in `.sh`, `.py`, or `.js` are the parts of a skill the client will
*execute* — by the agent via the `run_skill_script` tool, or directly via
`slask-client skill run` — and no other script or command in a skill is ever
run. Guardrails:

- **Path:** only files under `<skill dir>/scripts/`; anything that would
  traverse out of that folder is refused.
- **Extension:** only `.sh` (run via `bash`), `.py` (`python3`), and `.js`
  (`node`); other extensions are not scripts.
- **No shell injection:** scripts are spawned with an explicit argv array —
  no `shell: true`, no string interpolation — so arguments are individual
  argv elements, not shell input.
- **Limits:** a 30 s hard timeout (the child is killed) and output capped at
  the same 32 KiB the agent sees.
- **Environment/cwd:** the script inherits the client's environment plus
  `SLASK_SKILL_DIR` (set to the skill's directory, so a script can read sibling
  `references/` or `templates/`) and runs with the launch directory as its
  `cwd`.

The client runs whatever scripts its skills contain — that execution is the
user's responsibility (an opt-in, local-development feature operating on
user-authored skill directories; nothing is executed for skills the client
doesn't have). A missing `./skills/` (or an empty one) is a silent no-op;
`disabled: true` skills, duplicate names (first directory alphabetically wins),
flat files, and directories without a `SKILL.md` are all skipped.

Inspect or run skills without a model or an MCP connection:

    slask-client skill list                  # name + description, plus any bundled scripts
    slask-client skill show example          # body + bundled files
    slask-client skill run example format.sh <subject>

The chat REPL has a `/skills` command that lists the same information; a skill's
bundled scripts are also shown in the startup banner and via the agent's
`run_skill_script` tool.

## File tools

The client ships three **built-in** file tools that are always available to the
agent (they appear in the startup banner alongside server and skill tools):

| Tool            | What it does                                             | Required args             |
|-----------------|----------------------------------------------------------|---------------------------|
| `read_file`     | read a plain-text file — the whole file, or a byte range via `offset`/`bytes` | `path`, optional `offset`, `bytes` |
| `edit_file`     | atomic search-and-replace; never modifies unless it succeeds | `path`, `search`, `replace`, optional `replaceAll` |
| `write_file`    | create or overwrite a file, or append with `append: true` (parent dirs created as needed) | `path`, `content`, optional `append` |

- **`read_file(path, offset?, bytes?)`** returns the file text, its total
  byte count, and a `truncated` flag. The default read covers bytes from 0
  up to 64 KiB; for larger files, read a byte subset instead. Pass an
  optional 0-based byte offset (`offset`) and a byte count (`bytes`) to
  read any range — e.g. `read_file("big.txt", 65536, 65536)` reads bytes
  65536–131071 — and continue from the `next offset` the result reports to
  page through the file. Every read is capped at 65536 bytes (the per-call
  limit), reads are byte-oriented (a boundary that splits a multi-byte
  UTF-8 character renders as a replacement character — nudge `offset` a
  byte or two for a clean boundary), and a NUL byte inside the returned
  range is rejected as binary content with an actionable error.
- **`edit_file(path, search, replace[, replaceAll])`** implements "read → edit
  in memory → write back" as a *single atomic client step*: the file is only
  rewritten when the edit succeeds. `search` must match exactly once (or
  pass `replaceAll: true` to change every occurrence); an empty `replace`
  deletes the match. This avoids re-sending the whole file to a small model
  with a 1024-token completion cap.
- **`write_file(path, content[, append])`** creates or overwrites a plain-text
  file, creating any missing parent directories along the way. With `append`
  omitted or `false`, the file is created or fully overwritten (truncating).
  With `append: true`, `content` is added to the end of the file — the file is
  created if it does not yet exist. Use the append mode to write a large file
  in chunks: one `write_file` call for the first chunk (default overwrite),
  then each following chunk with `append: true`.

**Sandbox (enforced in client code, not by the agent).** All three tools only
touch paths under the **launch directory** — the directory where
`slask-client` was started — and its subdirectories. Refused by the client,
as model-actionable `ERROR calling …` feed-back:

- empty, absolute, or relative paths that resolve outside the launch dir
  (`..`, `../..`, `a/../../etc` — any depth);
- symlinks inside the launch directory that resolve to files *outside* it
  (including symlinked directories or symlinked parent paths for `write_file`).

The tools never touch the parent directory, any upstream directory, or
neighbouring folders — and since this check is in `files.ts`, no prompt
engineering or model "good behaviour" can weaken it.

## Scheduled jobs

Run prompts on a schedule with a small daemon. `slask-client schedule` keeps
a long-lived process alive that fires scheduled jobs while it is running. Jobs
come in two mutually exclusive forms: a *recurring* job (a 5-field cron
expression, fired on every match) and a *one-shot* job (an ISO-8601 date/time,
fired exactly once). Each firing runs the prompt through the client's ordinary
one-shot path (`--prompt`, with `--quiet` so the startup banner is omitted), so
a firing behaves exactly like you running `slask-client --prompt "…"` yourself.

Jobs are stored in `.slask-schedule.json` in the directory where the client is
run (the same cwd convention as `.env` / `mcp.json`):

```bash
# Recurring: run <prompt> whenever <expr> (standard 5-field cron) matches.
# The first fire is the *next* occurrence of <expr> after the job is added.
slask-client schedule add "*/5 * * * *" "summarize the last 5 news items"
slask-client schedule add "0 9 * * 1" "write a weekly report"

# One-shot: run <prompt> exactly once at an ISO-8601 date/time (UTC).
# An optional leading literal `at` is ignored before the date/time, shifting the
# date/time and prompt one slot right (purely for readability):
slask-client schedule add "2026-10-20T09:30:00Z" "check the deploy log"
slask-client schedule add at "2026-10-20T09:30:00Z" "check the deploy log"

# List jobs (id, schedule, prompt, last run / status).
slask-client schedule list

# Remove a job by full id or a unique id prefix.
slask-client schedule rm <id>
```

You can also manage jobs from the interactive REPL — type `/schedule add
<sched> <prompt>` (a one-shot `<sched>` may be preceded by the optional,
case-insensitive `at` keyword, which is simply ignored), `/schedule list`, or
`/schedule rm <id>` at the `slask-agent` prompt. `<sched>` is either a 5-field
cron (recurring: the first 5 whitespace-separated fields, and the prompt is
everything after field 5) or a space-free ISO date/time (one-shot).

**The model can manage schedules too.** Beyond the CLI and REPL, the agent can
create, change, list, and delete scheduled jobs directly through four always
available tools, so you can just ask in plain language:

- `schedule_list` — lists all jobs with their full UUID ids, schedule (cron
  expr or one-shot time), prompt, and last run / status. Use the id the tool
  gives you to reference a job unambiguously.
- `schedule_add` — creates a job: a 5-field cron `expr` plus a `prompt`
  (recurring, e.g. "remind me to check the deploy log every morning at 9")
  or an ISO date/time `at` plus a `prompt` (one-shot, e.g. "remind me once
  at 9:30 tomorrow").
- `schedule_update` — changes an existing job by id, taking a new cron `expr`,
  a new one-shot `at`, and/or a new prompt (exactly one of `expr`/`at` per
  call; e.g. "change that to 10am", "run that once at 5pm tomorrow").
- `schedule_remove` — deletes a job by id.

The model references jobs by their **full UUID** (exactly as `schedule_list`
prints it), not a short prefix. Note that the REPL's `/schedule` supports only
`add` / `list` / `rm`; editing a job goes through `schedule_update`.

**Running the daemon.** The daemon runs in the foreground and fires jobs only
while the process is alive. Ctrl+C stops it cleanly — it lets any in-flight
run finish (hard-killing after a 10 s grace) and exits 0:

```bash
# Foreground (Ctrl+C to stop).
slask-client schedule

# Keep it across terminal restarts / re-attach anytime (tmux).
tmux new -s sched
cd <your-dir>            # the directory with your .env / mcp.json
slask-client schedule
# detach with Ctrl-b Ctrl-d, reattach with: tmux attach -t sched

# Or background it with logs redirected.
cd <your-dir>
nohup slask-client schedule >/var/log/sched.log 2>&1 &
```

**Notes.**

- **Local time.** Cron expressions are evaluated in the system's local time
  zone. One-shot `at` times are stored in UTC (any ISO-8601 you pass is
  normalized to UTC), so they fire regardless of the machine's time zone.
  Jobs fire only while the daemon process is running. There is no built-in
  self-start; keep the daemon alive (tmux, systemd, a terminal, …).
- **One-shot behavior.** A one-shot fires exactly once at its `at` instant and
  is *not* removed afterwards — it stays in `schedule list`, now showing its
  `last` run/status (`ok`, `failed`, or `timeout`). `schedule_update` can also
  switch a job's kind (recurring ↔ one-shot) by providing exactly one of
  `expr`/`at`. If a one-shot's time passed while the daemon was down, it is
  skipped — never back-fired.
- **Live management.** The jobs file is re-read every 15 s
  (`SLASK_SCHEDULE_POLL_S`), so a live `add` / `rm` / `update` takes effect
  within one poll — no daemon restart needed. Changing a running job's cron
  expression reschedules it immediately; a changed prompt is picked up on the
  next firing.
- **Serialized runs.** At most one run at a time, queued FIFO, so a slow or
  hung firing can't starve the others or pile up unbounded.
- **Per-run timeout.** Each run has a 30 min default timeout
  (`SLASK_SCHEDULE_TIMEOUT_S`); on timeout the child is SIGTERMeD then
  SIGKILLEd and recorded as `lastStatus: timeout`. A successful run is
  recorded `ok`, a failed one `failed`; both set `lastRun`/`lastStatus`,
  which show in `schedule list`.

## Ralph loops (coding & research)

> Full run guide (requirements, files, scheduling, recovery): [RALPH.md](RALPH.md).

A *Ralph* run is an autonomous loop: a task list worked through by repeated
**fresh-context** agent iterations until every task passes (the pattern from
[snarktank/ralph](https://github.com/snarktank/ralph)). Each iteration is a
child `slask-client --prompt` process; its only memory is `prd.json`,
`progress.txt` and git. State lives in `.slask-ralph/<name>/` (cwd).

```sh
slask-client ralph init api --mode code --check "npm run build && npm test"
slask-client ralph add api "Add /health endpoint" --criteria "GET /health returns 200;test added"
slask-client ralph run api --max 10        # foreground; or `ralph start api` (detached)
slask-client ralph status api              # also: list, stop <name>
slask-client ralph init survey --mode research   # then add tasks; or --from prd.json
```

For a large project, attach a description file (e.g. a PRD): `ralph init shop
--spec tasks/prd-shop.md [--plan]` (copied to `.slask-ralph/shop/spec.md`; every
iteration reads the relevant parts; `--plan` drafts the task list headlessly) or
`/ralph init shop code tasks/prd-shop.md` then `/ralph plan shop` in chat (asks
clarifying questions first; chat commands take positional arguments, not `--flags`). The local `prd` skill writes such a PRD. See [RALPH.md](RALPH.md).

In chat, `/ralph plan <name> [code|research] [goal...]` has the model draft the
task list (it also has `ralph_*` tools, so "plan a research run on X" works);
`/ralph start <name>` launches it.

- **Completion is verified, not trusted.** The worker *claims* a task
  (`ralph_complete_task`); the loop then runs the verifier. `code`: your
  `--check` command (exit 0), then commits `feat: [T1] - title`. `research`: a
  separate fresh-context checker judges the acceptance criteria against
  `findings/<id>.md`; a final pass writes `report.md`.
- **Iterations are sized to the model's context window** (`contextTokens`, default
  32000; `ralph init --context <tokens>`): planners must produce small tasks (oversized ones are
  rejected), tool output is truncated and old output dropped, and a task that still doesn't fit is
  split automatically (`ralph split <name> <id>` by hand). See RALPH.md.
- A task that fails verification `maxFailures` (3) times in a row stops the run
  as `stuck`; the failure output is fed to the next attempt and `progress.txt`.
- Iterations get a `run_command` tool (one allow-listed program per call, no
  shell; allow-list in `config.json`) and higher limits (`SLASK_MAX_TOOL_ITERATIONS`
  40, `SLASK_MAX_TOKENS` 4096 — both overridable, also for normal chat).
- Detached runs and iterations inherit `--model/--base-url/--config` from the
  command that started them.
- **Where results go:** code runs change the workspace itself (and commit).
  Research runs write `findings/<task>.md` and the final `report.md` into the
  visible folder `ralph-<name>/` (override with `ralph init --out <dir>`, or
  `outputDir` in `ralph_create`). `.slask-ralph/<name>/` is internal loop state
  (prd.json, progress.txt, logs, status) and not meant to be read as a result.
- Local skill `ralph` has guidance on writing good task lists.
- **Workspace:** everything is relative to the directory the client runs in.
  `-C/--dir <path>` (any command) changes into that directory first, so you can
  start the client from anywhere/scripts: `slask-client -C ~/proj ralph run api`.
  `.env`, `mcp.json`, skills, file tools and the schedule file follow it too.

## Options & environment

| Command           | Flag| Env var        | Description                                                                                                 |
|-------------------|-----|----------------|-------------------------------------------------------------------------------------------------------------|
| -u, --url <url>   | -u  |                | MCP server endpoint (default: http://127.0.0.1:8000/mcp)                                                    |
| -t, --token <tok> | -t  | SLASK_MCP_TOKEN| bearer token for the default server (required when the server is set up with a token; otherwise leave blank)|
| -m, --model <name>| -m  | MODEL          | openai model (chat; default: gpt-4o-mini)                                                                   |
| --base-url <url>  |     | API_BASE       | openai base url (chat; default: https://api.openai.com)                                                     |
| -c, --config <path>| -c  | SLASK_MCP_CONFIG| extra servers (JSON); default: mcp.json in the current dir; missing explicit file is an error; missing default = no extra servers |
| -p, --prompt <text>| -p  | (none)         | run one agent turn with the prompt, print the answer, and exit (instead of the REPL) |
| OPENAI_API_KEY    |     | OPENAI_API_KEY | openai api key; only needed for the real openai endpoint (see API_BASE note)                                |
|                   |     | OPENAI_MODEL   | legacy model name (checked after MODEL)                                                                     |


## How the agent loop works

Each user turn runs a bounded OpenAI **function-calling** loop (default: up to 8 tool
round-trips per turn):

1. The model sees the system prompt, the conversation history, and the `tools` array
   (built from `tools/list` on every connected server, with `$schema` keys stripped).
2. If the model requests tool calls, each is **routed to the originating server** (raw
   name or `<serverName>__<toolName>` when names collide), the text result is fed back
   into the conversation, and the loop repeats.
3. When the model produces a final (non-tool-call) answer, it is printed and stored in
   history.

A failed tool call (unknown tool, transport error, or a server 4xx/5xx) is returned to
the model as an `ERROR calling …` message so it can adapt and continue — the session does
not crash.

## Errors

Errors go to stderr; the process exits non-zero. Common ones:

- `tool not found` — the named tool is not exposed by any connected server (run
  `list`). This is also what you see from `call` when no MCP servers are configured
  (the built-in file/schedule/skill tools are the only options, so a missing MCP
  tool name is a genuine not-found).
- `config error: …` — the `mcp.json`/`--config` file is missing (when explicitly named),
  has invalid JSON, or a server entry is malformed.

Unreachable servers are never fatal; they are reported as warnings (shown above) and the
client continues with whatever servers did connect plus the built-in tools.

