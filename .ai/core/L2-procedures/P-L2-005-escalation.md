---
id: P-L2-005
version: 0.4
title: Escalation and recovery: back-edges and budgets
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [all]
stages: [any]
triggers: [signal:defect-found, signal:budget-exhausted]
inputs: [attempt-results, findings-ledger]
outputs: [signals]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B]
evidence: [PROTO-DEC-0041:2, PROTO-DEC-0046, PROTO-DEC-0047:6]
cost_basis: unknown
---

# P-L2-005 Escalation and recovery

The record metadata declares its status, applicability and approval basis.

## Purpose

Enforce strict loop termination and prevent infinite rework by capping remediation attempts per root cause and defining explicit back-edge transitions.

## Rules

- R-L2-005.1. Escalation budgets allow at most two remediation attempts per root cause (budget <= 2).
- R-L2-005.2. Attempt counts bind to the root cause identifier and its affected paths, not to report instances or assistant sessions; changing the defect description while modifying the same code paths does not reset the attempt counter.
- R-L2-005.3. All recovery transitions must follow declared back-edges in the format `<from-step>><to-step>/<budget>/<exit>`; unbudgeted looping or agent-selected retries are forbidden.
- R-L2-005.4. Upon exhausting two attempts without verified resolution, the task immediately halts execution and escalates to independent audit via P-L2-007.
- R-L2-005.5. In state EXHAUSTED, automated watchdogs and schedulers must not re-trigger execution; resumption requires an explicit human owner block.
- R-L2-005.6. Repeat triggers boundary: Recovery loops and back-edges are constrained strictly to the four repeat triggers: (1) confirmed defect; (2) changed candidate or scope; (3) new external information; (4) incomplete closure proof.
- R-L2-005.7. Council prohibition: No new council or general discussion group may be convened without an explicit owner directive or an unresolved reproduced blocker.

## Steps

1. **Defect Signal Reception** (coordinator). Receive review finding or test failure; extract the root cause identifier and associated file paths.
2. **Attempt Evaluation** (coordinator). Query `attempt-results` for the existing attempt count of this root cause. If attempt count < 2, increment count and authorize fix round S-005.
3. **Budget Exhaustion Check** (coordinator). If attempt count >= 2 and defect remains unresolved, emit `signal:budget-exhausted` and set state to EXHAUSTED.
4. **Escalation Routing** (coordinator). Route the exhausted task to P-L2-007 budget audit; freeze affected paths from further modification.

## Stop conditions

- Attempt count reaches 2 without verified resolution.
- Defect premise is shown to contradict a higher source of truth (escalate via P-L0-002).
- Root cause cannot be mapped to declared task frame scope.

## Back edges

None; escalation transitions to audit or owner stop without intra-procedure looping.

## Evidence

- B - PROTO-DEC-0041:2: Maximum two remediation attempts per root cause.
- B - PROTO-DEC-0046: Objective stop rules and bounded back-edges.
- B - PROTO-DEC-0047:6: Watchdog and supervisor behavior under exhausted budget.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Renaming defect to evade budget | medium | high | Path-based root cause tracking (R-L2-005.2) | coordinator check | none |
| Watchdog re-triggers exhausted task | low | high | Explicit EXHAUSTED state check (R-L2-005.5) | script check | none |
| Fix attempts loop without bound | low | critical | Structural back-edges (R-L2-005.3) | schema enforcement | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
