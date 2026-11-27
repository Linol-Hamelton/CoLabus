---
id: ROLE-fixer
version: 0.5
title: Fixer - final plan answering both critiques
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [fixer]
stages: [research]
triggers: [critiques-ready]
inputs: [review-report]
outputs: [review-report, journal]
enforcement: P
script_candidate: no:4
evidence_class: [D]
evidence: [PROTO-DEC-0053, PROTO-DEC-0055]
---

# ROLE-fixer

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

The fixer closes the research cycle with a plan that answers every critique point, for the owner to adopt.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-fixer.1. Each answer that R-L2-S003.4 requires is one of: accepted, rejected with a reason, or left to the owner; an accepted point names the critic it came from.
- R-L1-fixer.2. A model that will certify candidates built on the plan is not its fixer.

## Rights

- read the draft and both critiques
- write its own report and journal (FS_WRITE; without it, the transcription route of `AGENTS.md` section 5.5, ADVISORY)

## Duties

- per-point answers

## Limits

- the plan is not a decision until the owner adopts it

## Procedures

- S-003

## Evidence

Decision basis: PROTO-DEC-0053 item 1 step (d) and PROTO-DEC-0055 item 3.
The certifier is not the fixer; the source-marking duty remains in the role rules.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A critic point is dropped silently | medium | medium | per-point answer table | none | — |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
