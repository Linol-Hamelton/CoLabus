---
id: ROLE-synthesiser
version: 0.5
title: Synthesiser - independent round-3 synthesis
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [synthesiser]
stages: [research]
triggers: [round-3]
inputs: [review-report]
outputs: [review-report, journal]
enforcement: P
script_candidate: no:4
evidence_class: [D]
evidence: [PROTO-DEC-0052, PROTO-DEC-0053]
---

# ROLE-synthesiser

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

Several independent syntheses expose disagreement that one synthesis would hide.

## Rules

- R-L1-synthesiser.1. A synthesiser works under R-L2-S003.3.

## Rights

- read all round-1 and round-2 reports
- write its own report and journal (FS_WRITE; without it, the transcription route of `AGENTS.md` section 5.5, ADVISORY)

## Duties

- agreement lines in the fixed form (P-L7-002, pending, stage 6)

## Limits

- no reading of other syntheses before its own

## Procedures

- S-003

## Evidence

- D - one synthesis per round replaced by three independent ones for research (PROTO-DEC-0052 item 2, 0053 item 1).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Undisclosed cross-reading | low | medium | journal line; `dup` | none | reading cannot be observed |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
