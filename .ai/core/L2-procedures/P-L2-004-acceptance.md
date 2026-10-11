---
id: P-L2-004
version: 0.4
title: Acceptance: candidate package, diff-certification, end-to-end reading
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [reviewer, certifier]
stages: [accept]
triggers: [stage-enter:accept]
inputs: [candidate-package, task-frame, environment-manifest]
outputs: [review-report, evidence]
back_edges: [6>8/2/owner]
enforcement: none
script_candidate: no:4
evidence_class: [A, B, D]
evidence: [PROTO-DEC-0038, PROTO-DEC-0041:3, PROTO-DEC-0041:4, PROTO-DEC-0049]
cost_basis: unknown
---

# P-L2-004 Acceptance

The record metadata declares its status, applicability and approval basis.

## Purpose

Prevent false acceptance, diverging verdicts, and stale certification by enforcing a deterministic candidate package, objective blocking rules, and end-to-end tool visibility.

## Rules

- R-L2-004.1. The candidate package consists of: Baseline (40-hex SHA), Candidate (40-hex SHA), Scope-ID (`kind:name`), Diff (computed path list and tree hash), Closes-findings (ledger ids resolving to findings-ledger, else exit 2), Producer-journal (path and entry hash), and Producer-Evidence (candidate digest). The package builder produces identical bytes for all certifiers.
- R-L2-004.2. In remediation rounds, diff-certification applies from round 2 (PROTO-DEC-0049 item 1); a certifier reads unchanged code only when modified code depends on it, documenting the reason in the review.
- R-L2-004.3. Reviewers and certifiers receive read access to the full text of all tools listed in the executor's environment-manifest; invoking or relying on any tool outside the manifest constitutes a finding.
- R-L2-004.4. Review verdicts belong to the closed vocabulary: PASS, FAIL, BLOCKED, RECOMMENDATION (PROTO-DEC-0041 item 3).
- R-L2-004.5. The objective blocking rule applies (PROTO-DEC-0041 item 4): any reproduced defect that (a) violates a recorded invariant or contract, OR (b) lies on a protected path (core, security, data, gates, hooks, validator, manifest) yields FAIL regardless of severity classification; lowering a mandatory defect to RECOMMENDATION under round limits, "not critical" claims, or voting is strictly prohibited.
- R-L2-004.6. Certification on high-risk paths requires no fewer than two parallel independent certifiers outside execution and control, each verifying with four required capabilities (FS_WRITE, SHELL_EXEC, EVIDENCE_SIGN, REPO_READ) and valid receipt.
- R-L2-004.7. Reproduction and symmetry of evidence: Any claim resulting in FAIL or BLOCKED requires at least one reproduction; otherwise the finding is advisory only and cannot block. Refutation of a finding carries the identical burden of proof verified on the same state; majority vote does not override reproduction.
- R-L2-004.8. Severity rubric: Review findings in the findings ledger are prioritized using a four-tier rubric:
  - `HIGH`: Violated recorded invariant, bypassed gate, or lost data/evidence -> Blocks (verdict `FAIL`).
  - `MEDIUM`: Violated contract or documented behavior without a bypassed gate -> Blocks (verdict `FAIL`) if on a protected path (core, security, data, gates, hooks, validator, manifest); non-blocking backlog item otherwise.
  - `LOW`: Documentation-to-behavior divergence, test coverage gap -> Non-blocking backlog item.
  - `INFO`: State drift, observation, not candidate defect -> Non-blocking.
- R-L2-004.9. Findings ledger format: Review reports must persist findings in a standardized 8-column ledger:
  `| ID | Requirement | Candidate | Reproduction | Actual Result | Severity | Disposition | Proof of Closure |`
  using the closed disposition analysis vocabulary: `confirmed | refuted | fixed-and-verified | deferred-by-owner | unresolved`.
- R-L2-004.10. Shared engine contract: Shared contracts across PowerShell and Node engines are never split into independently accepted halves; compatibility must be verified using a unified test matrix on identical inputs before acceptance.
- R-L2-004.11. Honest progress states: N/A and In progress are honest execution states; a gate check marked not applicable on an incomplete task certifies nothing and must never be treated as Completed.

## Steps

1. **Intake Candidate Package** (reviewer, certifier). Verify that the candidate package contains all required fields (Baseline, Candidate, Scope-ID, Diff, Closes-findings, Producer-journal, Producer-Evidence) and matches the task frame and block criteria (including positive and negative tests and closure conditions).
2. **Tool and Manifest Audit** (reviewer, certifier). Check the tools used against `environment-manifest`; flag any undeclared tool usage as an audit finding.
3. **Execution Verification** (reviewer, certifier). In an isolated worktree on the exact candidate commit SHA, execute the project validator, test suite, and targeted regression commands (including unified PowerShell and Node checks on shared contracts).
4. **Adversarial Audit** (reviewer, certifier). Inspect the diff against the Unified Adversarial Audit Prompt; hunt for defects, edge cases, regressions, and invariant violations.
5. **Findings Ledger and Verdict** (reviewer, certifier). Record every finding in the standardized 8-column findings ledger (`| ID | Requirement | Candidate | Reproduction | Actual Result | Severity | Disposition | Proof of Closure |`) with reproduction command and actual result; classify severity under the four-tier rubric (HIGH, MEDIUM, LOW, INFO); assign verdict from the closed dictionary (`PASS`, `FAIL`, `BLOCKED`, `RECOMMENDATION`).
6. **Report and Receipt** (certifier). Persist the certifying review report with `Mode: CERTIFYING`, session owner, and exact tree receipt; name the review document in the session journal.

## Stop conditions

- The candidate package is incomplete or missing required fields.
- The candidate diff touches paths outside the task frame's `scope`.
- A tool used during execution is missing from `environment-manifest`.
- A defect cannot be reproduced during verification.

## Back edges

- `6>8/2/owner`: When a review yields FAIL or BLOCKED, the candidate transitions to fix round S-005 (budget maximum 2 attempts per root cause; subsequent failures escalate to owner audit P-L2-007).

## Evidence

- A - PROTO-DEC-0038: Risk-scaled adversarial peer review and independent completion gates.
- B - PROTO-DEC-0041:3: Closed vocabulary of review verdicts.
- B - PROTO-DEC-0041:4: Objective blocking rule based on invariants and protected paths.
- D - PROTO-DEC-0049: Diff-certification and structured candidate packages.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Divergent severity ratings across reviewers | medium | high | Objective blocking rule (R-L2-004.5) | reviewer time | none |
| Candidate modified during review | low | high | Frozen candidate commit SHA (R-L2-004.1) | worktree isolation | none |
| Hidden tool dependencies | medium | medium | End-to-end reading from manifest (R-L2-004.3) | check step | none |
| Unverified advisory findings blocking progress | medium | medium | Reproduction requirement (R-L2-004.7) | audit check | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
