---
id: ROLE-certifier
version: 0.5
title: Certifier - independent final check whose verdict a gate counts
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [certifier]
stages: [accept]
triggers: [candidate-frozen]
inputs: [candidate-package]
outputs: [review-report, evidence, journal]
enforcement: S~
enforced_by: [.ai/bin/protocol-handoff.cjs]
script_candidate: no:4
evidence_class: [A]
evidence: [PROTO-DEC-0041, PROTO-DEC-0031, PROTO-DEC-0046, PROTO-DEC-0057, PROTO-DEC-0142, AGENTS.md:127]
---

# ROLE-certifier

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

The certifier is the independent check that lets work be accepted without the owner reading it all.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-certifier.1. R-L0-05 holds even when the certification runs as a task of its own, and across every frame of the candidate's lineage (P-L1-002).
- R-L1-certifier.2. Each of the two certifiers R-L0-05 requires gets the identical package at one committed SHA, works in its own worktree, and reads neither the other's report before fixing its own verdict: sealed mode (PROTO-DEC-0142 item 1). After a divergence, once both have filed, the certifiers read each other's reports and re-check the disputed point (PROTO-DEC-0142 item 3).
- R-L1-certifier.3. A certifying verdict needs FS_WRITE, SHELL_EXEC, EVIDENCE_SIGN and REPO_READ, set by the orchestrator, never self-declared.
- R-L1-certifier.4. In the standard cycle a certifier PASS approves the work on the certifier's authority; FAIL or RECOMMENDATION sends it to the owner.

## Rights

- issue a CERTIFYING verdict
- record its own Evidence

## Duties

- record the candidate SHA at start and end
- declare `Mode: CERTIFYING`, `Receipt-Owner`, `Independence: SEALED` and `Prior-reports-read: none` (PROTO-DEC-0142 item 5)

## Limits

- no certification of anything it shaped
- no second role in the same task

## Procedures

- P-L2-004 (pending, stage 3)
- P-L2-008
- P-L1-002

## Evidence

- A - independence and two certifiers (PROTO-DEC-0041 items 1-2; one SHA, own worktree, PROTO-DEC-0046 item 6); capabilities (PROTO-DEC-0031; `AGENTS.md:127`); approval on the certifier's authority and no self-certification in a separate task (PROTO-DEC-0057 items 2, 4).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Certifier limits run out | high | medium | availability order after the independence filter (PROTO-DEC-0047 item 1); diff-only rounds | waiting | no certifier available |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-10-03
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
