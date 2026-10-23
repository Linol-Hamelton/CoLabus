---
id: ROLE-drafter
version: 0.5
title: Drafter - draft decision built on the syntheses
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [drafter]
stages: [research]
triggers: [owner-directive]
inputs: [review-report]
outputs: [review-report, journal]
enforcement: P
script_candidate: no:4
evidence_class: [D]
evidence: [PROTO-DEC-0053, PROTO-DEC-0056]
---

# ROLE-drafter

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

The drafter turns the syntheses into one draft decision that states agreement, divergence and how each divergence is resolved.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-drafter.1. A draft states, for each point, where the syntheses agree, where they diverge, and how the divergence is resolved.

## Rights

- read all syntheses
- write its own report and journal (FS_WRITE; without it, the transcription route of `AGENTS.md` section 5.5, ADVISORY)

## Duties

- matrix of agreement with its consolidation rule stated

## Limits

- a draft is not a decision

## Procedures

- S-003

## Evidence

Decision basis: PROTO-DEC-0053 item 1 step (b).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The draft inherits its drafter's blind spots | medium | medium | two independent critiques | two sessions | — |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
