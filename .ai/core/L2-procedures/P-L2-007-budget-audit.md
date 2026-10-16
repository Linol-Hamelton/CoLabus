---
id: P-L2-007
version: 0.4
title: Budget exhaustion and escalation to audit
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator, auditor]
stages: [accept, execute]
triggers: [signal:budget-exhausted]
inputs: [attempt-results, findings-ledger, candidate-package]
outputs: [review-report]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B]
evidence: [PROTO-DEC-0041:2, PROTO-DEC-0046, PROTO-DEC-0047:6]
cost_basis: unknown
---

# P-L2-007 Budget exhaustion and audit

The record metadata declares its status, applicability and approval basis.

## Purpose

Prevent runaway remediation loops and unguided council proliferation when fix attempts fail, providing mechanical enforcement of stop states and structured transfer to independent audit.

## Rules

- R-L2-007.1. Findings ledger collection (R-05): the coordinator compiles all findings from review reports into a standardized 8-column ledger (`| ID | Requirement | Candidate | Reproduction | Actual Result | Severity | Disposition | Proof of Closure |`) plus the target candidate into a unified dossier before audit handover.
- R-L2-007.2. Attempt tracking: remediation attempts are logged in `docs/reviews/<batch>-attempt-results.jsonl` using status `running|failed|verified|unknown` keyed by `(scope, root-cause, attempt, candidate)`.
- R-L2-007.3. Stop rule states (`checkStopRule`): exit 0 (PASS) on `fixed-and-verified` or `refuted`; exit 1 (EXHAUSTED) on attempt 2 `confirmed` or `unresolved`; exit 0 (OWNER-EXCEPTION) on `deferred-by-owner` with valid approved block citation; exit 2 (UNKNOWN) on missing citation or conflicting events; exit 1 (STOP) on attempt >= 3.
- R-L2-007.4. Forbidden paths: when a root cause reaches EXHAUSTED, its touched code paths automatically enter the `forbidden` list of subsequent task frames; execution tools mechanically block modifications to those paths.
- R-L2-007.5. Audit handover: the coordinator opens `docs/reviews/<date>-<coordinator>-<root-cause>-budget-audit.md` containing attempt history, reproductions, and diffs. The assigned auditor must be completely outside the executing pair. The auditor produces recommendations; only the human owner decides on resumption. A third attempt is permitted strictly by an approved decision block.

## Steps

1. **Detect Budget Exhaustion** (coordinator). Identify that attempt 2 for a root cause has failed or remains unresolved per `attempt-results`.
2. **Lock Affected Paths** (coordinator). Mark paths touched by the root cause group as `forbidden` in active and subsequent task frames.
3. **Assemble Audit Dossier** (coordinator). Collect ledger findings, attempt logs, reproduction commands, and diffs into `docs/reviews/<date>-<coordinator>-<root-cause>-budget-audit.md`.
4. **Assign Independent Auditor** (coordinator). Dispatch the audit document to an auditor outside the executing pair.
5. **Conduct Audit Analysis** (auditor). Examine root causes, failure modes, and trade-offs; render an explicit recommendation (revert, owner directive, architectural redesign).
6. **Submit to Owner** (auditor, coordinator). Present findings and recommendations to the human owner for final ruling.

## Stop conditions

- Attempt count is less than 2 (remain in fix round S-005).
- Auditor belongs to the implementing or controlling pair (reassign to independent participant).
- Attempt results contradict recorded findings ledger.

## Back edges

None; budget exhaustion escalates directly to human owner resolution.

## Evidence

- B - PROTO-DEC-0041:2: Escalation budget capped at two remediation attempts per root cause.
- B - PROTO-DEC-0046: State machine definitions for automated stop checks.
- B - PROTO-DEC-0047:6: Mechanical path freezing and independent audit escalation.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Auditor biased by executing pair | medium | high | Strict independence invariant (R-L2-007.5) | coordinator check | none |
| Premature escalation before 2 attempts | low | medium | JSONL attempt ledger (R-L2-007.2) | script check | none |
| Modification of exhausted paths | low | critical | Mechanical forbidden paths list (R-L2-007.4) | scope gate | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
