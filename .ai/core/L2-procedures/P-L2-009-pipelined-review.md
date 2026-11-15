---
id: P-L2-009
version: 0.3
title: Pipelined review pilot - concurrent execution, candidate stacks, rebase rules
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [implementer, reviewer]
stages: [execute, accept]
triggers: [stage-enter:execute]
inputs: [candidate-package, task-frame]
outputs: [candidate-package, review-report]
back_edges: [3>1/2/owner]
enforcement: none
script_candidate: no:4
evidence_class: [C]
evidence: [PROTO-DEC-0062:4, PROTO-DEC-0066]
---

# P-L2-009 Pipelined review pilot

The record metadata declares its status, applicability and approval basis.

## Purpose

Enable asynchronous pipeline progression while maintaining strict review boundaries, capping work-in-progress, and defining deterministic rebase semantics.

## Rules

- R-L2-009.1. Work-in-progress cap: an implementer may have at most two candidates under review concurrently (WIP <= 2).
- R-L2-009.2. Candidate stack declaration: any pipelined candidate built on top of a candidate currently under review must declare its exact base commit via `Base: <candidate-sha>`.
- R-L2-009.3. Upstream failure rebase: if candidate 1 receives a FAIL or BLOCKED verdict, candidate 2 must rebase onto the fixed candidate 1 commit; verification reviews are invalidated only for paths affected by the rebase.
- R-L2-009.4. Strict stack landing: candidates must land into the kernel strictly in topological dependency order; merging candidate 2 before candidate 1 is prohibited.
- R-L2-009.5. Priority of open failures: before beginning a new candidate or stage, the implementer must collect all outstanding review reports; any open FAIL must be resolved before new work begins.

## Steps

1. **Submit Candidate 1** (implementer). Package candidate 1 and dispatch to independent reviewer.
2. **Launch Candidate 2** (implementer). While candidate 1 is under review, start candidate 2 on a branched worktree, declaring `Base: <candidate-1-sha>`.
3. **Collect Verdicts** (implementer). Inspect review results for candidate 1. If PASS, proceed to stage candidate 2 for review.
4. **Rebase if Upstream Failed** (implementer). If candidate 1 failed, pause candidate 2, execute fix round S-005 on candidate 1, and rebase candidate 2 onto the new SHA.
5. **Sequential Landing** (coordinator). Deliver candidate 1 to canon, followed by candidate 2 once certified.

## Stop conditions

- WIP exceeds 2 concurrent candidates under review.
- Upstream candidate receives FAIL but implementer attempts to certify downstream candidate.
- Rebase produces unresolvable merge conflicts.

## Back edges

- `3>1/2/owner`: Upstream review failure returns execution to remediation of candidate 1 (max 2 attempts before escalation to owner).

## Evidence

- C - PROTO-DEC-0062:4: Pipelined execution and asynchronous review pilot.
- C - PROTO-DEC-0066: Multi-stage task execution guidelines and depth bounding.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Cascade invalidation of work | medium | high | WIP <= 2 limit (R-L2-009.1) | rebase effort | none |
| Out-of-order merging | low | critical | Strict stack landing rule (R-L2-009.4) | order check | none |
| Ignoring open review findings | low | high | Mandatory verdict collection (R-L2-009.5) | gate check | none |

## Change log

- 0.1 — 2026-10-04
- 0.2 — 2026-10-04
- 0.3 — 2026-10-05
