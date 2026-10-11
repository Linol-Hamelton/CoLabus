---
id: S-004
version: 0.3
title: Kernel patch cycle - research, lifecycle, paired implementation, dual certification
layer: L2
type: scenario
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [procedure-author, reviewer, certifier, owner]
stages: [any]
triggers: [owner-directive, signal:kernel-change]
inputs: [task-frame, environment-manifest]
outputs: [review-report, evidence, candidate-package]
back_edges: [5>4/2/owner]
enforcement: P
script_candidate: no:4
evidence_class: [A, D]
evidence: [PROTO-DEC-0053, PROTO-DEC-0054:4, PROTO-DEC-0061]
cost_basis: unknown
---

# S-004 Kernel patch cycle

The record metadata declares its status, applicability and approval basis.

## Purpose

Govern modifications to the protocol kernel (`.ai/core/`), combining architectural research, formal procedure lifecycle, paired execution, and dual independent certification.

## Rules

- R-L2-S004.1. The kernel patch workflow combines design via S-003, record lifecycle via P-L0-001, implementation via S-002, and acceptance via P-L2-004.
- R-L2-S004.2. Every created or edited kernel record must conform strictly to the procedure schema, pass `protocol-core.cjs lint`, and preserve deterministic catalog order.
- R-L2-S004.3. Dual parallel certification (PROTO-DEC-0041 item 2): landing a kernel candidate requires no fewer than two parallel independent certifiers issuing PASS verdicts outside execution and control.
- R-L2-S004.4. Lower layer freeze invariance: frozen layers (L0, L1) are strictly immutable; any amendment below requires explicit owner authorization and amend-below accounting.
- R-L2-S004.5. Final landing into canon requires human owner approval (PROTO-DEC-0054 item 4); automated merge is prohibited.

## Steps

| # | Step | Role | Inputs | Outputs | Completion Criterion |
|---|---|---|---|---|---|
| 1 | Research & Design | procedure-author, owner | task-frame | review-report | Architectural alignment established per S-003 |
| 2 | Record Drafting | procedure-author | review-report | record-draft | Draft created and validated per P-L0-001 |
| 3 | Paired Implementation | procedure-author, reviewer | record-draft | candidate-package | Execution and integration checks green per S-002 |
| 4 | Dual Certification | certifier | candidate-package | review-report, evidence | Two independent certifiers issue PASS verdicts per P-L2-004 |
| 5 | Owner Landing | owner | review-report | CATALOG | Owner confirmation recorded and catalog regenerated |

## Stage graph

```
[Research S-003] → [Drafting P-L0-001] → [Execution S-002] → [Acceptance P-L2-004]
                                                                     │PASS
                                                                     ↓
                                                            [Dual Certification]
                                                                     │PASS
                                                                     ↓
                                                            [Owner Landing]
```

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| task-frame | owner, coordinator | procedure-author | valid scope | P-L2-001 |
| record-draft | procedure-author | reviewer | schema conformance | P-L0-001 |
| candidate-package | procedure-author | certifier | candidate digest | P-L2-004 |
| review-report | certifier | owner | dual PASS verdicts | P-L2-004 |
| CATALOG | procedure-author | all | deterministic order | P-L0-001 |

## Stop conditions

- Kernel record fails schema linting or catalog verification.
- Certifiers lack required independence from authoring session.
- Modification touches frozen lower layers without approved amend-below budget.

## Back edges

- `5>4/2/owner`: When dual certification yields FAIL, candidate returns to paired implementation (max 2 attempts; escalates to owner upon exhaustion).

## Evidence

- A - PROTO-DEC-0053: Council decision workflow and critique separation.
- A - PROTO-DEC-0054:4: Kernel work governed by explicit stages and owner approval.
- D - PROTO-DEC-0061: Stage 1 procedure lifecycle and schema enforcement.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Breaking frozen lower layer | low | critical | Layer consistency checks (R-L2-S004.4) | lcc check | none |
| Single-point certification bypass | low | critical | Dual certifier requirement (R-L2-S004.3) | gate validation | none |
| Schema drift during patch | low | high | Automated schema linting (R-L2-S004.2) | lint tool | none |

## Change log

- 0.1 — 2026-10-04
- 0.2 — 2026-10-04
- 0.3 — 2026-10-05
