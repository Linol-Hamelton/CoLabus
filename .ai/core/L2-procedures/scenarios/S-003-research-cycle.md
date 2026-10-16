---
id: S-003
version: 0.5
title: Research cycle - zones, challenges, independent syntheses, draft, critiques, final plan
layer: L2
type: scenario
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [researcher, synthesiser, drafter, critic, fixer, coordinator]
stages: [research]
triggers: [owner-directive]
inputs: [task-frame, journal]
outputs: [review-report, journal]
back_edges: []
enforcement: P
script_candidate: no:4
evidence_class: [D]
evidence: [PROTO-DEC-0052, PROTO-DEC-0053, PROTO-DEC-0055]
cost_basis: unknown
---

# S-003 Research cycle

The record metadata declares its status, applicability and approval basis.

## Purpose

Prevent blind spots and groupthink in design decisions by enforcing zone isolation, independent syntheses, and two parallel critiques before a final plan is submitted to the owner.

## Rules

- R-L2-S003.1. Round 1 has exactly one researcher per investigation zone.
- R-L2-S003.2. In round 2 no participant challenges its own zone; the round closes with one consolidated synthesis.
- R-L2-S003.3. Round-3 synthesisers do not read each other's syntheses before writing their own, and explicitly state compliance in their journals.
- R-L2-S003.4. A draft decision is followed by two critiques written independently of each other in the fixed agreement form, then a final plan that answers every critique point.
- R-L2-S003.5. Nothing produced during the cycle is a binding decision; only the human owner adopts, amends, or rejects the final plan.
- R-L2-S003.6. A missing report is recorded as pending, never as assumed agreement.

## Steps

1. **Frame** (coordinator). The owner's question, zones, participating slots, and line caps are established in the task frame.
2. **Round 1** (researcher). Exactly one report per zone exploring evidence and existing practices.
3. **Round 2** (researcher, synthesiser). Cross-challenges against non-owned zones; single consolidation synthesis.
4. **Round 3** (synthesiser). Three independent syntheses produced concurrently without cross-reading.
5. **Draft Decision** (drafter). Identification of consensus, divergence, and proposed resolutions.
6. **Critique** (critic). Two independent critiques evaluating the draft decision.
7. **Final Plan** (fixer). Resolution of every critique point (accepted, rejected with rationale, or deferred to owner).
8. **Owner Adoption** (coordinator, owner). Submission of final plan to owner for binding ruling.

## Stage graph

```
[Frame] → [Round 1] → [Round 2] → [Round 3: 3x Independent] → [Draft Decision]
                                                                     ↓
[Owner Adoption] ← [Final Plan] ← [Two Parallel Critiques] ←─────────┘
```

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| task-frame | coordinator | researcher | valid zones | P-L2-001 |
| review-report | researcher, synthesiser | drafter | non-empty | P-L2-004 |
| review-report | critic | fixer | agreement form | - |
| review-report | fixer | owner | complete mapping | - |

## Stop conditions

- An operational slot lacks an independent assigned participant.
- A round-3 synthesiser read another synthesis before writing (synthesis becomes advisory only).
- Final plan fails to address an accepted critique point.

## Back edges

None; the research scenario flows forward. Owner rejection terminates the cycle.

## Evidence

- D - PROTO-DEC-0052: Multi-zone research cycles and independent critique requirements.
- D - PROTO-DEC-0053: Council decision workflow and critique separation.
- D - PROTO-DEC-0055: Critic independence invariants.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Undisclosed cross-reading | medium | high | Journal statement of independence (R-L2-S003.3) | auditor check | reading unobservable |
| Uncontrolled round proliferation | low | high | Maximum 3 rounds (R-L2-S003.1..4) | coordinator limit | none |
| Critic certifying what it shaped | medium | high | Critic source attribution in final plan (step 7) | certifier check | none |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-10-04
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
