---
id: S-002
version: 0.4
title: Reusable paired work cycle - seven phases and completion gates
layer: L2
type: scenario
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [implementer, reviewer, certifier, coordinator, owner]
stages: [any]
triggers: [task-intake, owner-directive]
inputs: [task-frame, environment-manifest]
outputs: [review-report, evidence, candidate-package]
back_edges: [5>4/2/owner]
enforcement: P
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0041:1, PROTO-DEC-0041:2, PROTO-DEC-0041:3, PROTO-DEC-0041:4]
cost_basis: unknown
---

# S-002 Reusable paired work cycle

The record metadata declares its status, applicability and approval basis.

## Purpose

Provide a reproducible multi-assistant paired work cycle with structured phases, independent verification, and clear separation between controller and certifier.

## Terms

- **Phase**: Bounded stage of work with a defined output and a checkable transition gate.
- **Primary pass**: A single evaluation of a specific artifact version against the agreed scope.
- **Discussion round**: Participants submit their position once on a common input packet; the controller issues a disposition.
- **Remediation**: Modification addressing a confirmed defect. Verification of this fix is the subsequent pass, never an unconstrained general council.
- **Independence**: The reviewer is not the author of the change; for high-risk final verification, the reviewer is additionally neither the author of disputed premises nor the controller of execution.
- **Defect**: A unique violation of a verifiable requirement. A verdict, a finding count, or a document count is not a defect.
- **Uncertainty**: Incomplete data or missing capability. Yields `BLOCKED` or an explicit open inquiry, never a confirmed defect and never `PASS`.
- **Verification version**: Concrete Git commit SHA plus working tree status and Evidence receipt digest.

## Rules

- R-L2-S002.1. The cycle executes across seven sequential phases (0: Frame, 1: Diagnosis, 2: Solution, 3: Plan and adversarial review, 4: Implementation done-checked, 5: Final adversarial audit, 6: Closure and backlog).
- R-L2-S002.2. Controller is not certifier (PROTO-DEC-0041 item 1): an agent acting as coordinator or controller may shape work and dispatch waves, but may never issue a certifying verdict on what it controlled.
- R-L2-S002.3. Mandatory parallelism (PROTO-DEC-0041 item 2): parallel certifiers on high-risk candidates receive identical packages, work concurrently, and do not read each other's reports prior to persisting their own.
- R-L2-S002.4. Objective blocking rule: any reproduced invariant violation or defect on a protected path yields FAIL regardless of severity classification; renaming to RECOMMENDATION by round limits or voting is strictly prohibited.
- R-L2-S002.5. Remediation budget allows at most two attempts per root cause; failures beyond attempt 2 escalate directly to independent budget audit via P-L2-007.
- R-L2-S002.6. One primary pass per phase: A repetition is strictly forbidden unless triggered by one of exactly four repeat triggers: (1) confirmed defect; (2) changed candidate or scope; (3) new external information; (4) incomplete closure proof. Repetition is never scheduled in advance.
- R-L2-S002.7. Shared contract rule: A contract shared by two engines (PowerShell and Node) is never split into independently accepted halves; compatibility must be verified using a unified test matrix on identical inputs.
- R-L2-S002.8. Single synthesis: Each evaluation round produces exactly one synthesis and one findings disposition table; redundant per-participant agreement documents are prohibited.

## Steps

| # | Phase | Role | Inputs | Outputs | Completion Criterion | Primary Passes | Repeat Triggers |
|---|---|---|---|---|---|---|---|
| 0 | Frame | coordinator, owner | task-intake-record | task-frame, env-manifest | Scope, risk class, and immutable baseline set | 1 | Scope or contract change |
| 1 | Diagnosis | implementer | task-frame | findings-ledger | Core premises and defect reproduction verified | 1 | New evidence contradicts premise |
| 2 | Solution | implementer, coordinator | findings-ledger | review-report | One recommendation and at most two alternatives | 1 discussion | Owner requests alternative; factual conflict unresolved |
| 3 | Plan Review | reviewer | review-report | review-report | Independent review leaves no open mandatory defect | 1 independent pass | Plan-level blocker discovered |
| 4 | Execution | implementer | task-frame | candidate-package, evidence | Block criteria met, local checks pass, prompt persisted | 1 per block + 1 integration | Test failure; reviewer finding |
| 5 | Adversarial Audit | certifier | candidate-package | review-report, evidence | Parallel independent certifiers issue PASS or RECOMMENDATION | 1 | FAIL/BLOCKED; candidate changed |
| 6 | Closure | owner, coordinator | review-report | journal | Documentation reconciled, receipts valid, sessions stopped | 1 | New facts reopen decision |

## Stage graph

```
[Phase 0: Frame] → [Phase 1: Diagnosis] → [Phase 2: Solution] → [Phase 3: Plan Review]
         ↓
[Phase 4: Execution] → [Phase 5: Adversarial Audit] ──PASS──→ [Phase 6: Closure]
         ↑                          │FAIL (<=2 attempts)
         └──────────────────────────┘
```

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| task-frame | coordinator | implementer | valid fields | P-L2-001 |
| env-manifest | coordinator | implementer, certifier | valid tools | P-L2-001 |
| candidate-package | implementer | reviewer, certifier | valid format | P-L2-004 |
| review-report | reviewer, certifier | coordinator, owner | closed vocabulary | P-L2-004 |
| evidence | implementer, certifier | coordinator | deep verification | PROTO-DEC-0042 |

## Stop conditions

- Controller attempts to issue a certifying verdict on its own work.
- Parallel certifiers read each other's outputs before recording.
- Remediation attempts for a single root cause exceed 2.

## Back edges

- `5>4/2/owner`: When Phase 5 yields FAIL or BLOCKED, execution returns to Phase 4 (max 2 attempts per root cause; escalates to owner upon exhaustion).

## Evidence

- A - PROTO-DEC-0041:1: Controller cannot certify what it directed or controlled.
- B - PROTO-DEC-0041:2: Maximum two remediation attempts per root cause.
- B - PROTO-DEC-0041:3: Closed vocabulary for verdicts.
- B - PROTO-DEC-0041:4: Objective blocking rule.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Self-certification by controller | low | critical | Invariant R-L2-S002.2 | verification check | none |
| Serial discussion rounds reduce accuracy | medium | high | Parallelism invariant R-L2-S002.3 | dispatch check | none |
| Endless fix cycles | low | high | Back-edge budget limit R-L2-S002.5 | schema enforcement | none |

## Operational stage mapping

The owner's 12 operational stages map directly onto these seven phases:
- "Поиск проблем" (Problem search) -> Phase 1.
- "Исследование практик" (Practice research) -> Phase 1a (research cycle S-003).
- "Выработка решений" + "обсуждение решений" (Solution development & discussion) -> Phase 2 (single discussion round).
- "Выработка плана" + "обсуждение плана" + "составление плана" (Plan formulation & review) -> Phase 3.
- "Реализация сделано-проверено" (Done-checked implementation) -> Phase 4.
- "Аудит итогов" and "корректирующие циклы" (Results audit & corrective cycles) -> repeats of Phases 4 and 5 upon trigger (S-005), not separate phases.
- "Враждебный аудит итога" (Adversarial audit of results) -> Phase 5.
- "Постановка задач нового цикла" (Next cycle tasking) -> Phase 6.

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
