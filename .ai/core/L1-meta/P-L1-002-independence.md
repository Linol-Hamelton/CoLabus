---
id: P-L1-002
version: 0.6
title: Independence - who counts as one participant, and when independence is checked
layer: L1
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator, certifier, reviewer]
stages: [frame, dispatch, accept]
triggers: [role-assignment, candidate-frozen]
inputs: [task-frame, journal]
outputs: [journal, stop-question]
back_edges: []
enforcement: S~
enforced_by: [.ai/bin/protocol-scope.cjs]
script_candidate: yes
evidence_class: [A, B]
evidence: [PROTO-DEC-0038, PROTO-DEC-0041, PROTO-DEC-0047, PROTO-DEC-0048, PROTO-DEC-0056, PROTO-DEC-0057, PROTO-DEC-0063]
cost_basis: unknown
---

# P-L1-002 Independence

The independence contract is defined below; SCHEMA-assignment defines the input grammar. The enforcement level and implementing tools are declared in the record metadata.

## Purpose

A check is worth only as much as the independence of whoever makes it. The rules of independence
already have homes: the root, the selection procedure and the role records. This procedure adds
what they leave open: who counts as the same participant, over which frames independence is
judged, and when it is checked.

## Rules

- R-L1-002.1. The participant is the model, named by its maker's id in the model matrix. A client
  alias, a new session, another client or another effort level of the same model is the same
  participant, so a new session inherits every role its model held in the candidate's lineage.
  This is the one home of the participant rule; SCHEMA-assignment section 1 points here.
- R-L1-002.2. A candidate's lineage is every task frame in which the candidate was produced, fixed,
  reviewed, framed, dispatched, coordinated or otherwise controlled: every act that R-L0-05 and
  R-L1-coordinator.2 bar from certifying. Independence is judged over the whole lineage, not the
  certifying frame alone.
- R-L1-002.3. Any participant may report FAIL or BLOCKED with a reproduction; only an independent
  certifier issues PASS or RECOMMENDATION toward a gate.
- R-L1-002.4. The number of checks scales with risk: high risk (Class A) as R-L0-05 requires (two
  parallel independent certifiers); low risk (Class B, docs, config, low blast radius) one
  independent reviewer statement per PROTO-DEC-0038 item 2. The former medium risk level was
  eliminated by PROTO-DEC-0136.

### Rules this procedure checks, by home

| Rule | Home |
|---|---|
| no one certifies what they authored, executed or controlled; two certifiers for high risk | R-L0-05 |
| one model, one role per task frame; rotation between steps | R-L2-002.2, R-L2-002.3 |
| certification as a separate task; lineage | R-L1-certifier.1 |
| two certifiers on one package and SHA, neither reading the other | R-L1-certifier.2 |
| the coordinator certifies nothing it framed, dispatched or controlled | R-L1-coordinator.2 |
| the reviewer is the controller of what it reviews | R-L1-reviewer.5 |
| the implementer never reviews its own candidate | R-L1-implementer.3 |
| the author never reviews its own record | R-L1-procedure-author.2 |
| critics write independently | R-L2-S003.4 |
| synthesisers, researchers do not read each other first | R-L2-S003.3, R-L1-researcher.2 |
| a certifier-to-be is not the fixer | R-L1-fixer.2 |
| a shadow verdict never counts | R-L1-shadow-certifier.1 |

## Steps

1. **At assignment** (coordinator or owner). Before writing a role line, resolve each model to its
   matrix id (R-L1-002.1), collect the lineage of the candidate (R-L1-002.2), and check every rule
   in the table above against it. A conflict is not written; it goes to step 4.
2. **At orientation** (any role). P-L1-001 step 5 checks the one-role rule from the session's side.
3. **At certification** (certifier). The report names the lineage frames it checked and states that
   the certifier holds none of the excluded roles in them. The gate checks the role lines of every
   frame of the lineage.
4. **No eligible model** (coordinator). If the independence filter leaves a needed slot empty, the
   availability order of PROTO-DEC-0047 item 1 is applied to what remains; if nothing remains,
   P-L0-002 to the owner.

## Stop conditions

- A needed slot has no eligible model (step 4).
- A model id that the matrix does not hold: the assignment waits for P-L3-002.

## Back edges

None.

## Evidence

Independence and two certifiers: PROTO-DEC-0041 items 1-2. Risk-scaled checks:
PROTO-DEC-0047 items 2-3 and PROTO-DEC-0038 item 2. Participant identity:
PROTO-DEC-0056 item 2 and PROTO-DEC-0063 item 2. Certification as its own task:
PROTO-DEC-0057 item 4. No historical round-cost measurement is supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Splitting work into frames to escape a rule | medium | high | R-L1-002.2 judges the lineage, not the frame | lineage lookup | influence that no frame records |
| A client reports a model under another id | medium | medium | R-L1-002.1 resolves ids through the matrix; an unknown id stops | one lookup | a client that hides the model |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-02
- 0.4 — 2026-10-03
- 0.5 — 2026-10-04
- 0.6 — 2026-10-05
