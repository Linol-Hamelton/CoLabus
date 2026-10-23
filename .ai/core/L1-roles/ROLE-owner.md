---
id: ROLE-owner
version: 0.5
title: Owner - the human who holds all authority
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [owner]
stages: [any]
triggers: [stop-question, stage-exit, owner-directive]
inputs: [stop-question, review-report]
outputs: [.ai/DECISIONS.md]
enforcement: S~
enforced_by: [validate-protocol.ps1]
script_candidate: no:4
evidence_class: [A]
evidence: [AGENTS.md:52, PROTO-DEC-0030, PROTO-DEC-0062]
---

# ROLE-owner

Unlike every other slot, this one is held by the human owner and never by a model: no assignment line names it (SCHEMA-assignment section 2; R-L0-04).

## Purpose

The owner is the only source of authority in the kernel. Every other slot acts inside what the owner has approved or delegated.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-owner.1. What R-L0-04 reserves to the owner includes approving stages, retirements and exceptions; an approval binds only as a decision block (P-L0-005).
- R-L1-owner.2. The owner may delegate the assignment of roles within a recorded scope; a delegation never transfers the authority to approve.

## Rights

- approve, amend or reject any proposal, stage or plan
- name executors and delegate role assignment
- set or lift freezes and exceptions

## Duties

- answer stop-questions
- record a delegation in writing (to whom, which task frames, until when)

## Limits

- none set by the kernel; a choice binds once it is recorded as a decision block

## Procedures

- P-L0-002 (answers)
- P-L0-005 (decisions)
- P-L0-001 step 8
- P-L0-007 step 6

## Evidence

- A - "The human owner decides. Ask rather than assume." (`AGENTS.md:52`); transcription rule PROTO-DEC-0030; delegation PROTO-DEC-0062 item 3.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Owner attention is the scarcest resource | high | high | stop-questions in five blocks; delegation for routine assignment | owner time | the owner is away |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
