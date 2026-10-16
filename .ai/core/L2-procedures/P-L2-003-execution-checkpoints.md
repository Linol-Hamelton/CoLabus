---
id: P-L2-003
version: 0.4
title: Execution with checkpoints and cost accounting
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [implementer]
stages: [execute]
triggers: [stage-enter:execute]
inputs: [task-frame, environment-manifest]
outputs: [journal, candidate-package, attempt-results]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0047:6, PROTO-DEC-0061]
cost_basis: unknown
---

# P-L2-003 Execution with checkpoints

The record metadata declares its status, applicability and approval basis.

## Purpose

Govern bounded task execution, enforce 15-minute checkpoint cadence, track resource costs, and prevent out-of-scope edits during implementation.

## Rules

- R-L2-003.1. Execution is strictly constrained to the declared paths in `task-frame` under `scope`; modifying any path outside `scope` or listed under `forbidden` is prohibited.
- R-L2-003.2. Checkpoint frequency (PROTO-DEC-0047 item 6): the implementer records progress checkpoints in the session journal at least every 15 minutes of execution or after each completed block.
- R-L2-003.3. Tool constraints: execution must use only the tools declared in `environment-manifest`; discovering or using unauthorized external tools is prohibited.
- R-L2-003.4. Local verification and block specification: Each discrete change must satisfy its block declaration fields (including positive test, negative test, and closure condition) with local validator and test runs before proceeding.
- R-L2-003.5. Unilateral completion prohibited: the implementer must never set task status to `Completed` in `.ai/TASK.md`.

## Steps

1. **Intake Frame & Manifest** (implementer). Read `task-frame` and `environment-manifest`; confirm permitted scope, forbidden paths, and tool access.
2. **Execute Scoped Changes** (implementer). Perform implementation block by block under the shared lock.
3. **Record Checkpoints** (implementer). Every 15 minutes or upon block completion, write a checkpoint line to the session journal.
4. **Local Verification** (implementer). Run targeted tests and `validate-protocol.ps1` (or Node validator); ensure 0 warnings.
5. **Prepare Candidate** (implementer). Package candidate diff, update journal with five labels, persist adversarial audit prompt, and hand off to review.

## Stop conditions

- Required change falls outside declared task frame scope (request frame update via coordinator).
- Required tool is absent from `environment-manifest`.
- 15-minute checkpoint interval exceeded without recording progress.

## Back edges

None; execution flows block-by-block towards acceptance.

## Evidence

- A - PROTO-DEC-0047:6: 15-minute checkpoint cadence and watchdog monitoring.
- B - PROTO-DEC-0061: Bounded execution within approved procedure lifecycle.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Silent hang during execution | medium | medium | 15-minute checkpoint rule (R-L2-003.2) | journal entry | none |
| Uncontrolled path modification | low | high | Scope path enforcement (R-L2-003.1) | git diff | none |
| Premature task closure | low | critical | Prohibition on unilateral completion (R-L2-003.5) | validator | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
