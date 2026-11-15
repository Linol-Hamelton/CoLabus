---
id: ROLE-dispatcher
version: 0.5
title: Dispatcher - a script that launches sessions, never a model
layer: L1
type: role
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [dispatcher]
stages: [dispatch]
triggers: [stage-enter:dispatch]
inputs: [task-frame, environment-manifest]
outputs: [journal]
enforcement: none
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0050, PROTO-DEC-0051, PROTO-DEC-0055]
cost_basis: attempts=3
---

# ROLE-dispatcher

Unlike the model slots, this one is held by a script (R-L1-dispatcher.1), so no assignment line names it (SCHEMA-assignment section 2).

## Purpose

The dispatcher launches agents from recorded model, effort and task inputs.
Explicit inputs make launch commands checkable and reduce quoting and flag mistakes.

Выбор модели использует [selection-policy.json](../../../docs/ops/selection-policy.json):
roleBindings задаёт роль выбора; loadingProfiles задаёт отдельную шкалу загрузки инструкций.

## Rules

- R-L1-dispatcher.1. The dispatcher is a script and makes no decisions.
- R-L1-dispatcher.2. It launches each session as P-L2-006 prescribes (pending, stage 3), naming the model and effort of R-L2-002.4.

## Rights

- start, wake and stop sessions within the recorded budgets

## Duties

- log requested and observed model and effort

## Limits

- no choice of model, role or scope; those come from the frame

## Procedures

- P-L2-006 (pending, stage 3)

## Evidence

Decision basis: PROTO-DEC-0050, PROTO-DEC-0051 item 4 and PROTO-DEC-0055
item 5. Recorded launch inputs avoid command construction assumptions;
this document supplies no measured failure rate or success claim.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The script is trusted before it is certified | medium | high | script standard (PROTO-DEC-0047 item 8); shadow run | one certification | — |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-03
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
