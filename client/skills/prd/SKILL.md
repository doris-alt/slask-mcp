---
name: prd
description: Write a Product Requirements Document (PRD) for a feature or project before building it with Ralph. Use when the user says "create a prd", "write a spec", or "plan this project" and wants a project description file that `ralph init --spec` can use.
---

Produce a PRD as a markdown file, then hand it to Ralph. Do NOT start implementing.
(Adapted from snarktank/ralph's prd skill.)

## 1. Clarify first (3-5 questions)

Ask only what you can't infer: the problem/goal, core functionality, scope
boundaries, success criteria, technical constraints. Give each question lettered
options so the user can answer tersely ("1A, 2C"):

```
1. What is the primary goal?
   A. Replace the old import flow   B. Add a new report   C. Improve performance   D. Other: ...
```

Wait for the answers. If the request is already unambiguous, skip this step.

## 2. Write the PRD

Save to `tasks/prd-<short-name>.md` (kebab-case) with these sections:

1. **Introduction** — what it is and the problem it solves.
2. **Goals** — specific, measurable objectives.
3. **User Stories** — `US-001: Title`, "As a <user>, I want <x> so that <y>", plus
   **Acceptance Criteria** as a checklist. Each story must be small enough for one
   focused work session; split anything bigger. Criteria must be *verifiable*:
   "GET /health returns 200 and a test covers it", "`npm run build` passes" — never
   "works correctly". (Unlike the original, don't write "verify in browser" criteria
   unless a browser tool is available; use a command or a file check.)
4. **Functional Requirements** — numbered, explicit: FR-1, FR-2, ...
5. **Non-Goals** — what is out of scope.
6. **Design Considerations** — UI/UX, components to reuse.
7. **Technical Considerations** — constraints, dependencies, existing code to build on,
   build/test commands (Ralph needs a `check` command for code runs).
8. **Success Metrics** — measurable outcomes.
9. **Open Questions** — anything still unclear.

For a research project, replace user stories with **Research Questions** (one per item,
each with criteria demanding cited sources) and describe the deliverable (report outline).

Write for a junior developer: explicit, unambiguous, no jargon, numbered requirements,
concrete examples. Order stories by dependency (schema -> backend -> UI).

## 3. Hand off to Ralph

Tell the user the next step:

```
slask-client ralph init <name> --spec tasks/prd-<short-name>.md --mode code --check "<build+test cmd>" --plan
```

(or `/ralph plan <name> --spec tasks/prd-<short-name>.md` in chat for an interactive
version). `--plan` drafts the task list from the PRD; review it with
`slask-client ralph status <name>` before `ralph run`.
