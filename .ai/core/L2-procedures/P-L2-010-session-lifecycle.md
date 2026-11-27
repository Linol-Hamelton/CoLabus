---
id: P-L2-010
version: 0.4
title: Session start and end lifecycle, hooks, and verification handoff
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [all]
stages: [session]
triggers: [session-start, session-end]
inputs: [task-frame, journal]
outputs: [journal, evidence]
tools: [TOOL-protocol-hooks, TOOL-validate]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [A]
evidence: [PROTO-DEC-0047, PROTO-DEC-0061]
---

# P-L2-010 Session start and end

The record metadata declares its status, applicability and approval basis.

## Purpose

Standardize session initialization, context loading, pre-handoff verification, and safe termination across all participating AI coding assistants.

## Rules

- R-L2-010.1. At session start, every assistant must read `.ai/TASK.md`, inspect working tree state (`git status --short --branch` and `git log -10`), take repository inventory (`git ls-files`), read recent journals in `.ai/worklog/`, and inspect `.ai/DECISIONS.md` whenever touching architecture, data, or contracts.
- R-L2-010.2. Every session must obtain its identity (session id, owner name, journal path) either through an active SessionStart hook or by running `node .ai/bin/protocol-session.cjs start --agent <name>`. Lock operations and handoff receipts bind to this reported owner name.
- R-L2-010.3. SessionStart hook context injection is strictly bounded; assistants remain responsible for explicitly reading omitted files relevant to their assigned scope.
- R-L2-010.4. Before session completion, the assistant must review its diff (`git diff`), execute `validate-protocol.ps1` (or Node validator), run the source regression suite and host tests, and record real exit codes.
- R-L2-010.5. At session end, the assistant writes exactly one entry in its designated session journal containing all five mandatory labels, updates `.ai/TASK.md` under lock if state changed, releases any held locks, and exits without running `git commit`, `git tag`, or `git push` unless explicitly ordered by the owner.
- R-L2-010.6. Capacity reservation: Sessions must verify reserve corpus and journal capacity before creating artifacts, executing classify-first archiving when limits approach.

## Steps

1. **Session Start** (all). Initialize session via hook or `protocol-session.cjs start`; retrieve owner name and journal file.
2. **Context Intake** (all). Read `.ai/TASK.md`, run `git status`, verify source list against repository inventory, and read recent worklogs.
3. **Lock Acquisition** (all). Acquire cooperative lock via `protocol-lock.cjs acquire --owner <owner-name>` before editing shared documents.
4. **Execution & Checks** (all). Perform scoped modifications; run local tests and project validator.
5. **Session End & Evidence** (all). Review diff, record evidence via `protocol-handoff.cjs record --owner <owner-name>`, write 5-label journal entry, update TASK, release lock.

## Stop conditions

- `.ai/TASK.md` indicates no active task and no assignment has been given by the owner.
- Working tree contains uncommitted changes belonging to another live session.
- Pre-handoff checks fail without reproduction or resolution.

## Back edges

None; session lifecycle executes sequentially from start to end.

## Evidence

- A - PROTO-DEC-0047: Standardized session lifecycle, journal ownership, and hook wiring.
- A - PROTO-DEC-0061: Stage 1 baseline for procedure execution and verification handoff.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Unchecked repository state on start | medium | high | Mandatory inventory and git checks (R-L2-010.1) | startup time | none |
| Multiple sessions writing same journal | low | critical | Unique session journal per owner (R-L2-010.2) | hook check | none |
| Handing off unverified changes | medium | critical | Mandatory diff and validator execution (R-L2-010.4) | test time | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
