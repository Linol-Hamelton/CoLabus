---
id: S-005
version: 0.4
title: Fix round - targeted remediation of review findings
layer: L2
type: scenario
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [implementer, reviewer]
stages: [execute, accept]
triggers: [verdict:FAIL]
inputs: [review-report, findings-ledger, candidate-package]
outputs: [candidate-package, review-report, evidence]
back_edges: [4>2/2/owner]
enforcement: P
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0040, PROTO-DEC-0041:2, PROTO-DEC-0049:1]
cost_basis: unknown
---

# S-005 Fix round

The record metadata declares its status, applicability and approval basis.

## Purpose

Execute targeted remediation of reproduced defects without uncontrolled code rewrites or infinite fix iterations.

## Rules

- R-L2-S005.1. Remediation is strictly targeted: changes must relate directly to confirmed defects in the findings ledger; unrelated refactoring is prohibited.
- R-L2-S005.2. Diff-certification applies (PROTO-DEC-0049 item 1): the reviewer re-inspects only modified files and dependent interfaces, preserving prior pass findings.
- R-L2-S005.3. Attempt budget is strictly limited to 2 per root cause; a second failed attempt immediately triggers budget exhaustion.
- R-L2-S005.4. Symmetry of evidence: A refutation of a finding carries the exact same burden of proof as the finding itself, demonstrating resolution with the exact reproduction command from the finding on the same relevant state; a majority vote does not override an empirical reproduction.
- R-L2-S005.5. Four repeat triggers boundary: Remediation is initiated strictly upon trigger 1 of the four repeat triggers (confirmed defect reproduced against candidate; other triggers: changed candidate/scope, new external info, incomplete closure proof). Arbitrary or unbudgeted remediation passes are prohibited.

## Steps

| # | Step | Role | Inputs | Outputs | Completion Criterion |
|---|---|---|---|---|---|
| 1 | Finding Triage | implementer | review-report | findings-ledger | All confirmed defects identified with reproduction steps |
| 2 | Targeted Patch | implementer | findings-ledger | candidate-package | Fix code within declared scope; reproduction fails then passes |
| 3 | Local Check | implementer | candidate-package | evidence | Full local validation passes; updated prompt persisted |
| 4 | Re-Review | reviewer | candidate-package, evidence | review-report | Diff review verifies closure of findings |

## Stage graph

```
[Finding Triage] → [Targeted Patch] → [Local Check] → [Re-Review] ──PASS──→ [Accept]
                          ↑                                 │FAIL (attempt < 2)
                          └─────────────────────────────────┘
                                                            │FAIL (attempt = 2)
                                                            └──→ [P-L2-007 Audit]
```

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| findings-ledger | reviewer | implementer | reproduced items | P-L2-004 |
| candidate-package | implementer | reviewer | valid patch | P-L2-004 |
| review-report | reviewer | coordinator | valid verdict | P-L2-004 |

## Stop conditions

- Finding claim cannot be reproduced.
- Scope of required fix extends outside task frame boundaries.
- Attempt counter reaches 2 without resolution.

## Back edges

- `4>2/2/owner`: When re-review yields FAIL, execution returns to step 2 (max 2 attempts; escalates to owner upon exhaustion).

## Evidence

- A - PROTO-DEC-0040: Bounded paired-cycle remediation and role separation.
- B - PROTO-DEC-0041:2: Maximum two remediation attempts per root cause.
- D - PROTO-DEC-0049:1: Diff-certification in remediation rounds.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Fix introduces regressions | medium | high | Full local test pass (step 3) | test time | none |
| Drive-by refactoring during fix | low | medium | Scope check (R-L2-S005.1) | reviewer audit | none |
| Third fix attempt attempted | low | high | Budget check (R-L2-S005.3) | schema enforcement | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
