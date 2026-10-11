---
id: ROLE-implementer
version: 0.4
title: Implementer - does the work inside the frame
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [implementer]
stages: [execute]
triggers: [dispatch]
inputs: [task-frame, environment-manifest]
outputs: [journal, evidence, candidate-package]
enforcement: S~
enforced_by: [validate-protocol.ps1, .ai/bin/protocol-handoff.cjs]
script_candidate: no:4
evidence_class: [A]
evidence: [AGENTS.md:77, PROTO-DEC-0041, PROTO-DEC-0047, PROTO-DEC-0048]
---

# ROLE-implementer

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

The implementer changes the repository within the task frame and leaves a record that others can check.

## Rules

- R-L1-implementer.1. The implementer works only inside the frame's scope.
- R-L1-implementer.2. The implementer never marks a task Completed alone.
- R-L1-implementer.3. The implementer never reviews its own candidate; certification is barred by R-L0-05.
- R-L1-implementer.4. The implementer writes a checkpoint line after each block and records producer Evidence for the candidate.

## Rights

- edit files in scope
- run the checks
- ask stop-questions

## Duties

- write the orientation line first (P-L1-001)
- answer every finding: fixed, rejected with a reason, or left to the owner

## Limits

- no edit outside scope
- no commit, tag or push without the owner
- one role per model in a task

## Procedures

- P-L1-001
- P-L0-002
- P-L2-008

## Evidence

- A - no unilateral Completed (`AGENTS.md:77`); independence (PROTO-DEC-0041 item 1); checkpoints (PROTO-DEC-0047 item 6); producer Evidence (PROTO-DEC-0048 item 5).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Scope creep | medium | medium | scope check against the frame (P-L9-001, pending, stage 6) | none | judgement at the scope edge |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-10-03
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
