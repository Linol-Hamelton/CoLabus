---
id: ROLE-procedure-author
version: 0.4
title: Procedure author - writes kernel records through P-L0-001
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [procedure-author]
stages: [any]
triggers: [signal:procedure-gap, owner-directive]
inputs: [signals, CATALOG]
outputs: [record-draft, journal]
enforcement: P
script_candidate: no:4
evidence_class: [A]
evidence: [.ai/core/L0-meta/P-L0-001-procedure-lifecycle.md:51, PROTO-DEC-0061]
---

# ROLE-procedure-author

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

Every kernel record has an author who owns its dossier and its consistency check, and who never reviews it.

## Rules

- R-L1-procedure-author.1. The procedure author is the actor of P-L0-001 under R-L0-17, and runs the LCC of its layer (R-L0-19.2).
- R-L1-procedure-author.2. A procedure author never reviews its own record.

## Rights

- draft records and their dossiers

## Duties

- run the layer consistency check (P-L0-004)

## Limits

- no approval, no review of its own records

## Procedures

- P-L0-001
- P-L0-004
- P-L0-006

## Evidence

The author ownership requirement is R-L0-17.6 in P-L0-001.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The author waves through its own draft | medium | high | review by another model; LCC line checked by the reviewer | one review | — |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-10-03
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
