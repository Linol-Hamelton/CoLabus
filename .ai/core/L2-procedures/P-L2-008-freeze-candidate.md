---
id: P-L2-008
version: 0.5
title: Freeze a candidate before its certification starts
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator, implementer, certifier]
stages: [freeze]
triggers: [stage-enter:freeze]
inputs: [task-frame, journal]
outputs: [candidate-package, evidence]
back_edges: [5>4/1/owner]
enforcement: none
script_candidate: no:4
evidence_class: [B]
evidence: [PROTO-DEC-0046, PROTO-DEC-0047, PROTO-DEC-0049]
cost_basis: unknown
---

# P-L2-008 Freeze a candidate

The record metadata declares its status, applicability and approval basis.

## Purpose

Ensure certification evaluates a fixed, immutable state by requiring that every candidate is committed only on declared scope paths before review begins.

## Rules

- R-L2-008.1. Certification of a candidate starts only after its freeze commit exists.
- R-L2-008.2. The freeze commit contains only paths inside the frame's `scope`; unrelated work in the tree stays out of it.
- R-L2-008.3. Every certifier works on that one SHA, in its own worktree, and records the SHA at start and end.
- R-L2-008.4. Authorisation for the commit itself follows the git rule of the code layer; this procedure governs timing and path isolation.

## Steps

1. **Close the Work** (implementer). All streams of the candidate stop; the journal records a checkpoint naming the last change.
2. **List the Paths** (coordinator). Run `git status` against the frame's `scope`; any path outside the declared scope is excluded and noted in the journal.
3. **Authorise** (owner, via coordinator). Confirm authorization for the commit.
4. **Commit** (coordinator). Execute a path-scoped commit containing exactly the listed paths.
5. **Package** (coordinator). Build the candidate package (Baseline, Candidate, Scope-ID, Diff, Closes-findings, Producer-journal, Producer-Evidence) and verify candidate digest. If the diff shows out-of-scope paths, return to step 4 (back-edge 5>4).
6. **Hand Over** (coordinator). Provide the identical candidate package to both certifiers.

## Stop conditions

- The owner does not authorise the freeze commit.
- Diff contains paths outside the declared scope after one correction.

## Back edges

- `5>4/1/owner`: A candidate whose diff leaves declared scope returns to commit once; a second failure escalates to the owner.

## Evidence

- B - PROTO-DEC-0046: Path-scoped candidate isolation requirement.
- B - PROTO-DEC-0047: Consequences: freeze commits must be path-scoped to prevent unrelated work entering certification.
- B - PROTO-DEC-0049: Diff-certification requires an immutable baseline candidate SHA.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Needed file omitted from freeze | medium | medium | Package diff check (step 5) | one commit | none |
| Unrelated changes leak into review | low | high | Path-scoped commit (R-L2-008.2) | git isolation | none |
| Certifiers evaluate different states | low | critical | Mandatory single SHA (R-L2-008.3) | SHA check | none |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-10-04
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
