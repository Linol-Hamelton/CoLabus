---
id: ROLE-auditor
version: 0.5
title: Auditor - examines a root cause whose budget is exhausted
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [auditor]
stages: [accept]
triggers: [budget-exhausted]
inputs: [findings-ledger, attempt-results]
outputs: [review-report]
enforcement: P
script_candidate: no:4
evidence_class: [A]
evidence: [PROTO-DEC-0048, PROTO-DEC-0046]
---

# ROLE-auditor

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

When two attempts on one root cause have failed, someone outside the pair examines why, instead of a third attempt.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-auditor.1. The auditor is outside the implementing pair of the root cause it examines.
- R-L1-auditor.2. The auditor recommends; only the owner reopens a root cause or opens a third attempt.

## Rights

- read both attempts, their diffs and reproductions
- write its own report and journal (FS_WRITE; without it, the transcription route of `AGENTS.md` section 5.5, ADVISORY)

## Duties

- one audit report in `docs/reviews/`

## Limits

- no fix of its own

## Procedures

- P-L2-007 (pending, stage 3)

## Evidence

- A - budget exhaustion goes to an audit (PROTO-DEC-0048 item 4); two attempts per root cause (PROTO-DEC-0046 item 4).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| No auditor is available | medium | medium | the owner names one | owner attention | — |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
