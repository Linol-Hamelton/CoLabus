---
id: ROLE-reviewer
version: 0.6
title: Reviewer - adversarial check before a stage or candidate moves on
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [reviewer]
stages: [accept]
triggers: [stage-exit, candidate-ready]
inputs: [candidate-package, task-frame, environment-manifest]
outputs: [review-report, findings-ledger, journal]
enforcement: P
script_candidate: no:4
evidence_class: [A]
evidence: [PROTO-DEC-0041, PROTO-DEC-0054, PROTO-DEC-0057, PROTO-DEC-0142]
---

# ROLE-reviewer

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

A second pair of eyes that hunts for defects before the work goes further: to the owner for kernel work, to the certifier in the standard cycle.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-reviewer.1. The reviewer reads everything it checks, including the tools the implementer used.
- R-L1-reviewer.2. Its verdict token and its reproductions follow P-L2-004 (pending, stage 3); until then PROTO-DEC-0041 items 3-5 (vocabulary, blocking rule, symmetry of evidence) and `AGENTS.md:137-138` apply. In sequential mode (advisory reviews, plan reviews, point rounds and re-checks, PROTO-DEC-0142 item 2) the reviewer reads the prior reports and either confirms a finding or adds a new one; a confirmation carries the reviewer's own reproduction, never a reference to the prior report (PROTO-DEC-0142 item 4).
- R-L1-reviewer.3. The reviewer never edits the candidate.
- R-L1-reviewer.4. For kernel work its PASS or RECOMMENDATION sends the stage to the owner; in the standard cycle it sends the work to the certifier.
- R-L1-reviewer.5. The reviewer is the controller, in the sense of R-L0-05, of everything it reviews.

## Rights

- read anything
- run any check read-only
- append findings to the ledger
- write its own report and journal (FS_WRITE; without it, the transcription route of `AGENTS.md` section 5.5, ADVISORY)

## Duties

- diff-only review from the second round, widening where needed and saying why (PROTO-DEC-0049 item 1)
- record the model and effort it ran with
- declare `Independence: SEALED | SEQUENTIAL` and `Prior-reports-read: <paths or none>` in the report header (PROTO-DEC-0142 item 5)

## Limits

- no edits to the candidate
- no certification of what it controlled

## Procedures

- P-L2-004 (pending, stage 3)
- P-L0-004 step 4
- P-L1-002

## Evidence

- A - closed verdicts and reproductions (PROTO-DEC-0041 items 3, 5); stage order (PROTO-DEC-0054 item 4, 0057 item 2); the reviewer reads the candidate.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| One reviewer model accumulates blind spots | medium | high | model rotation between steps (PROTO-DEC-0056 item 2); two certifiers at landing | none | shared training blind spots |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-03
- 0.5 — 2026-10-04
- 0.6 — 2026-10-05
