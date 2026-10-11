---
id: P-L2-002
version: 0.8
title: Choose the executor, model and effort for a task before it is launched
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [all]
stages: [triage, dispatch]
triggers: [stage-enter:triage]
inputs: [task-frame, journal]
outputs: [task-frame, journal]
back_edges: [7>5/1/owner]
enforcement: P
script_candidate: no:4
evidence_class: [B, C]
evidence: [PROTO-DEC-0047, PROTO-DEC-0055, PROTO-DEC-0058, PROTO-DEC-0059, PROTO-DEC-0072, PROTO-DEC-0074, PROTO-DEC-0075, PROTO-DEC-0086]
cost_basis: unknown
---

# P-L2-002 Choose executor, model and effort

The record metadata declares its status, applicability and approval basis.

## Purpose

Each task runs in a new session with model and effort named explicitly
(PROTO-DEC-0055 item 5). Complexity determines the tier; that tier and the other
roles determine model selection. Rotation between steps provides different model
perspectives. Record those choices and verify the actual client settings.

## Rules

- R-L2-002.1. The tier of a task is computed before launch from the rubric below and written in
  the task frame (`tier`).
- R-L2-002.2. Within one task, one model holds one role. A model that already holds a role in the
  task is not chosen for another.
- R-L2-002.3. Between consecutive steps of a piece of work, prefer a different model from the one
  that did the previous step, when one of the right tier is available.
- R-L2-002.4. The session is launched with the chosen model and effort named explicitly; the
  model does not change inside the session.
- R-L2-002.5. The session's first journal line records the model and effort it actually runs
  with (`Launch: model=<id> effort=<value|unknown> client=<client>`); a mismatch with the frame
  is reported as `Tier-mismatch:` and a relaunch is requested.
- R-L2-002.6. A brand name is never a reason. The reason is the tier, the role constraint of
  R-L2-002.2 and the rotation of R-L2-002.3.

## Steps

1. **Frame** (coordinator). The task frame exists with goal, scope and risk class.
2. **Score** (coordinator). Score each factor 0-2:

| Factor | 0 | 1 | 2 |
|---|---|---|---|
| Protected paths | none | tests or kernel documents | `.ai/`, validator, gates, hooks |
| Novelty | precedent exists | partial | none |
| Reversibility | trivial revert | revert with migration | irreversible or external |
| Ambiguity | no open question | 1-2 | ≥ 3 or conflicting sources |
| Coupling | one layer | two layers | ≥ 3 layers |
| Independent judgement | the work follows a precise specification or a fixed procedure | review or critique that another participant checks | a judgement others rely on without re-deriving it: certification, architecture, or a high-responsibility synthesis, specification or audit |

> Volume is not a factor: the tier follows uncertainty and the consequence of an error
> (PROTO-DEC-0074 item 4, 0075 item 8). The six factors operationalize the four parameters of
> 0075 item 8: Novelty and Ambiguity (uncertainty and reasoning depth), Reversibility and
> Protected paths (the consequence of an error), Coupling (cross-system coupling) and Independent
> judgement (the independent judgement required). Context
> window, modality, tools, route capability and language support are hard constraints, checked
> when the route is resolved, not scored.

3. **Tier** (coordinator). Map the sum to a tier (PROTO-DEC-0059): 0 → T1; 1-2 → T2; 3 → T3;
   4-5 → T4; 6 → T5; 7-8 → T6; 9 → T7; 10-11 → T8; 12 → T9.
   > Hard floors: a certification is at least T7, and so is a task that directly creates, changes or
   > applies a candidate kernel record, kernel code or protocol tooling. A research, design or review
   > frame that produces only advisory artefacts does not take that floor because its result may
   > later change the kernel, and a review-only task takes the rubric's tier unless another rule sets
   > a higher floor (PROTO-DEC-0072). A protected path is at least T4.
   Write `tier` and the six scores in the frame.
4. **Exclude** (coordinator). List the models that already hold a role in this task (R-L2-002.2).
5. **Choose** (coordinator, or the owner when the owner launches). From the tier map, take an
   available model of the tier that is not excluded, preferring one different from the previous
   step's model (R-L2-002.3). Choose the effort the map gives for the tier. Write both in the frame.
6. **Launch** (dispatcher or owner). Name the model and effort at launch (R-L2-002.4).
7. **Confirm** (the executor). First journal line as R-L2-002.5. On a mismatch, the coordinator
   relaunches once (back edge 7>5); a second mismatch goes to the owner.

## Tier table

The table is built by P-L3-002 (model discovery), never filled from memory or preference
(PROTO-DEC-0058). Per provider it has nine tiers: three model ranks (workhorse, second,
flagship) times three effort levels (minimum, middle, maximum). The model rank comes first
(PROTO-DEC-0059):

> The ranks T1-T9 are relative inside one provider: "T7" of one provider does not name the same
> capability as "T7" of another (PROTO-DEC-0086 item 5, recorded as an input of this revision).
> PROTO-DEC-0059 is unchanged.

| | minimum | middle | maximum |
|---|---|---|---|
| workhorse | T1 | T2 | T3 |
| second | T4 | T5 | T6 |
| flagship | T7 | T8 | T9 |

The current table, with a source for every cell, is 
(first run of P-L3-002 and P-L3-003, 2026-09-24; owner answers PROTO-DEC-0064, 0065). This
procedure reads it and never copies it (R-L0-12).

## Stop conditions

- No available model of the tier is left after step 4: go to P-L0-002 (the owner decides).
- The frame is missing: the tier cannot be computed.

## Back edges

- `7>5/1/owner`: a launch that does not match the frame is relaunched once; a second mismatch goes
  to the owner.

## Evidence

Decision basis: PROTO-DEC-0047 item 9, PROTO-DEC-0056 item 2,
PROTO-DEC-0074 item 4 and PROTO-DEC-0075 item 8. Effort scales differ by client.
The tier follows uncertainty and error consequence, never volume; independent
judgement is the fourth parameter, the sum remains 0-12 and the
PROTO-DEC-0059 mapping remains unchanged. Trial: M-007. The supplied document
does not validate this rubric against current tasks or establish provider availability.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The rubric under-rates protected work | medium | high | hard floors in step 3 | none | judgement in scoring |
| A tier cell is wrong | medium | medium | cells come only from P-L3-002 with their source and date; mismatch lines | one relaunch | provider information that is itself wrong |
| Rotation leaves no model of the tier | low | medium | stop to the owner | owner attention | — |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-09-24
- 0.4 — 2026-09-25
- 0.5 — 2026-09-26
- 0.6 — 2026-10-03
- 0.7 — 2026-10-04
- 0.8 — 2026-10-05
