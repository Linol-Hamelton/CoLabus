---
id: P-L0-009
version: 0.3
title: Next action - execute, delegated judgement, owner decision or stop
layer: L0
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160]
roles: [all]
stages: [any]
triggers: [before-owner-question, action-not-named-by-step]
inputs: [task-frame, journal, decisions-index]
outputs: [journal, stop-question, signals]
back_edges: []
enforcement: P
script_candidate: no:1
evidence_class: [C]
evidence: [PROTO-DEC-0070, PROTO-DEC-0081]
---

# P-L0-009 Next action: the four outcomes

Anchored by R-L0-38; extends P-L0-002. The record metadata declares its status and approval basis.

## Purpose

An agent either asks the owner again for what is already allowed, which makes the owner a bottleneck, or acts on its own reading of what is "obviously" allowed, which widens authority silently; this procedure names the four outcomes of a next action and the closed list of cases in which the owner is asked.

## Rules

- R-L0-38.1. STOP. An action outside the task's allowed scope, or onto a forbidden path, is not
  taken. A change already outside the scope stops the work at once, and P-L0-002 steps 1-3
  follow (PROTO-DEC-0070 item 4; R-L0-10.8).
- R-L0-38.2. OWNER-DECISION. The owner is asked, through the stop-question of P-L0-002, only when
  authority is missing; scope, permissions or delegation would widen; an exception to a rule is
  needed; binding sources conflict unresolved; several materially different admissible options
  remain and no procedure delegates the choice; a previously unauthorised irreversible action is
  needed; a provided budget or back-edge is exhausted; or the rules give UNKNOWN rather than a
  definite result (PROTO-DEC-0070 item 6).
- R-L0-38.3. DELEGATED-JUDGEMENT. When several admissible actions remain and a role or a
  procedure explicitly delegates the choice, the participant chooses without owner confirmation
  and records the choice, the alternatives and the delegating source (PROTO-DEC-0070 item 6).
- R-L0-38.4. EXECUTE. When the rules and the current state admit exactly one admissible action,
  and an approved decision, an active procedure, a task frame, a recorded authorisation or another
  recorded delegation allows it unambiguously without widening scope, authority or permissions,
  the participant takes it and records the basis (PROTO-DEC-0070 item 5).
- R-L0-38.5. A basis is a recorded source, cited by its decision id or `path:line`. A
  participant's own judgement that an action is obvious, implied or equivalent is not a basis
  (PROTO-DEC-0070 item 5: "recorded").
- R-L0-38.6. The outcomes are tested in the order STOP, OWNER-DECISION, DELEGATED-JUDGEMENT,
  EXECUTE; the first that applies is the outcome.

## Steps

1. **Test STOP** (any role): test R-L0-38.1, and on STOP go to P-L0-002.
2. **Test OWNER-DECISION** (any role): test the eight cases of R-L0-38.2, and on a match go to P-L0-002 step 4 with the case named in block 2 of the stop-question.
3. **Test DELEGATED-JUDGEMENT** (any role): test R-L0-38.3, and on a match choose and record in the journal the outcome, the choice, the alternatives and the source.
4. **Test EXECUTE** (any role): test R-L0-38.4, and on a match act and record in the journal the outcome, the action and the basis. No match in steps 1-4 is the case "the rules give UNKNOWN" of R-L0-38.2.

## Stop conditions

The outcomes STOP and OWNER-DECISION are the stops; both continue in P-L0-002.

## Back edges

None.

## Evidence

Decision basis: PROTO-DEC-0070 items 4-6 and PROTO-DEC-0081.
The resolver order in R-L0-38.6 is an implementation proposal, not a quotation
of an owner instruction; it tests fail-safe outcomes first.
Trial: M-002 (owner clarifications per stop-question), counted by hand from
journals until L6 defines it; kill and until remain in front matter.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A basis read too broadly | medium | high | R-L0-38.5: a basis is a cited recorded source; the reviewer checks the citation | one citation per action | no script checks it until the capability envelope exists |
| The owner is asked too often | medium | medium | the closed list of R-L0-38.2 | none | a thin rule set yields UNKNOWN often |

## Open

The record retains unresolved design questions: the capability envelope descriptor;
inheritance of permissions on resume and fallback; expiry and supersession of an
authorisation; bounds of delegated judgement; the delegation artifact; and acceptance
checks for those contracts. Dispatcher enforcement of these items requires their
approved definitions (PROTO-DEC-0081 Consequences). This product projection does not
resolve these questions or activate such enforcement.

## Change log

- 0.1 — 2026-09-26
- 0.2 — 2026-10-03
- 0.3 — 2026-10-04
