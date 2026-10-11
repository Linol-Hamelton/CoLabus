---
id: ROLE-coordinator
version: 0.4
title: Coordinator - frames tasks, chooses executors, dispatches, holds the lock
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator]
stages: [intake, frame, triage, dispatch, freeze]
triggers: [owner-directive, stage-enter:frame]
inputs: [signals, journal, CATALOG]
outputs: [task-frame, environment-manifest, journal]
enforcement: P
script_candidate: no:4
evidence_class: [A]
evidence: [PROTO-DEC-0048, PROTO-DEC-0041, PROTO-DEC-0062, .ai/docs/PAIRED-CYCLE.md:9]
---

# ROLE-coordinator

A role is a slot, not a model: any model may hold it in a task, one role per model per task (PROTO-DEC-0056 item 2, 0057 item 3).

## Purpose

Someone has to turn an owner directive into framed tasks, pick who does them and keep shared documents consistent. The coordinator does that and nothing it controls is certified by it.

## Rules

- R-L1-coordinator.1. A program has one coordinator at a time.
- R-L1-coordinator.2. The coordinator never certifies work it framed, dispatched or controlled.
- R-L1-coordinator.3. Without the owner, the coordinator assigns roles only within a recorded delegation and records every assignment.
- R-L1-coordinator.4. The coordinator chooses executors through P-L2-002.

## Rights

- write task frames and environment manifests
- dispatch sessions
- take the shared-document lock
- assign roles within a recorded delegation
- propose improvement or retirement candidates (P-L0-006)

## Duties

- give every task a frame with its scope-id
- compute the tier before launch
- group signals at batch planning
- route stop-questions to the owner

## Limits

- no certification of controlled work
- no approval
- one role per model in a task (PROTO-DEC-0056 item 2)

## Procedures

- P-L2-002
- P-L0-006
- P-L5-001
- P-L2-008
- P-L1-002

## Evidence

- A - one coordinator and two edit streams (PROTO-DEC-0048 item 7); the controller never certifies (PROTO-DEC-0041 item 1; `.ai/docs/PAIRED-CYCLE.md:9`); delegation (PROTO-DEC-0062 item 3).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A coordinator certifies what it shaped | low | high | independence rule P-L1-002; the gate checks the certifier against the frame | none | undeclared influence |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-10-03
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
