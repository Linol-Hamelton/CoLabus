---
id: S-001
version: 0.5
title: Task lifecycle trunk - CORE-ARCH stage 3
layer: L2
type: scenario
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [all]
stages: [any]
triggers: [task-intake, session-start]
inputs: [signals, CATALOG]
outputs: [candidate-package, journal, evidence]
back_edges: [5>10/1/owner, 6>8/2/owner, 6>9/1/owner, 1>10/1/owner, 2>10/1/owner, 3>10/1/owner, 4>10/1/owner, 6>10/1/owner, 7>10/1/owner, 8>10/1/owner, 9>10/1/owner]
enforcement: none
script_candidate: no:4
evidence_class: [A, D]
evidence: [PROTO-DEC-0054, PROTO-DEC-0057:2, PROTO-DEC-0075:6]
---

# S-001 Task lifecycle trunk

The record metadata declares its status, applicability and approval basis.

## Purpose

Provide a single, verifiable path for task execution with artifact-based transitions.

## Rules

R-L2-S001.1. Every task enters at Intake and exits through Close or Stop.
R-L2-S001.2. Transition by artifact only, never by agent choice.
R-L2-S001.3. Node passed only when PROTO-DEC-0075 item 6 criterion met.
R-L2-S001.4. Every transition has a non-empty output artifact.
R-L2-S001.5. Back edges carry budget and exit.

## Steps

| # | Node | Procedure | Inputs | Outputs | Criterion | Closes |
|---|---|---|---|---|---|---|
| 1 | Intake | - | signals,CATALOG | task-intake-record | PROTO-DEC-0075:6 | coord/owner |
| 2 | Frame+Manifest | P-L2-001 | task-intake-record | task-frame,env-manifest | PROTO-DEC-0075:6 | coord |
| 3 | Triage | P-L2-002 | task-frame,env-manifest | complexity-class,tier | PROTO-DEC-0075:6 | coord |
| 4 | Dispatch | P-L2-006 | complexity-class,tier,task-frame | dispatch-record | PROTO-DEC-0075:6 | coord |
| 5 | Execute | P-L2-003 | dispatch-record,task-frame,env-manifest | exec-journal,attempt-results | PROTO-DEC-0075:6 | impl |
| 6 | Accept | P-L2-004 | exec-journal,attempt-results,candidate | verdict,review-report | PROTO-DEC-0075:6 | reviewer/owner |
| 7 | Close | - | verdict | closed-record | PROTO-DEC-0075:6 | owner/certifier |
| 8 | Fix round | S-005 | verdict(FAIL),attempt-results | fix-response,fixed-candidate | PROTO-DEC-0075:6 | impl |
| 9 | Audit | P-L2-007 | attempt-results,exec-journal | audit-report | PROTO-DEC-0075:6 | auditor |
| 10 | Stop | P-L0-002 | any | stop-question | PROTO-DEC-0075:6 | owner |

## Stage graph

[Intake]->[Frame+Manifest P-L2-001]->[Triage P-L2-002]->[Dispatch P-L2-006]->[Execute P-L2-003]->[Accept P-L2-004]--PASS-->[Close]
                                      |FAIL (<=2)
                                      +--->[Fix round S-005]--->[Accept]
                                      |exhausted
                                      +--->[Audit P-L2-007]--->[Close]
any--premise/rule error-->[Stop P-L0-002]

This is  section 3 lines 61-68.

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| task-intake-record | Intake | Frame+Manifest | non-empty | - |
| task-frame | Frame+Manifest | Triage/Dispatch/Execute | valid fields | P-L2-001 |
| env-manifest | Frame+Manifest | Dispatch/Execute | valid | - |
| complexity-class | Triage | Dispatch | valid | - |
| tier | Triage | Dispatch | valid | - |
| dispatch-record | Dispatch | Execute | valid | - |
| exec-journal | Execute | Accept/Audit | valid | - |
| attempt-results | Execute | Accept/Audit/Fix | valid JSONL | spec-4 |
| candidate | Execute | Accept | valid | P-L2-004 |
| verdict | Accept | Close/Fix | closed vocab | PROTO-DEC-0041:3 |
| review-report | Accept | Close | valid | - |
| fix-response | Fix round | Accept | valid | S-005 |
| fixed-candidate | Fix round | Accept | valid | P-L2-004 |
| audit-report | Audit | Close | valid | P-L2-007 |
| stop-question | Stop | - | valid | P-L0-002 |
| closed-record | Close | - | valid | - |

## Stop conditions

Stop to P-L0-002 when: no artifact for transition, criterion not met, transition by choice, premise/rule wrong.

## Back edges

- 6>8/2/owner: Accept FAIL to Fix round, max 2 per root cause
- 6>9/1/owner: Accept budget exhausted to Audit
- 1>10/1/owner through 9>10/1/owner: any node to Stop on premise/rule error

## Evidence

Decision basis: PROTO-DEC-0075 item 6 (completion), PROTO-DEC-0054
(owner involvement) and PROTO-DEC-0057 item 2 (closure authority).
No historical implementation comparison is supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Agent chooses transition | medium | high | explicit graph | reviewer | modeled transition |
| Missing artifact | medium | high | table check | author | edge without artifact |
| Unbounded fix loops | low | high | budget <=2 | minimal | 3rd attempt |
| Authority confusion | medium | medium | explicit who closes | reviewer | inconsistent closure |
| Wrong exit | low | medium | explicit exit | auditor | non-owner exit |

## Change log

- 0.1 — 2026-09-29
- 0.2 — 2026-09-29
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
