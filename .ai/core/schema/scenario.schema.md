---
id: SCHEMA-scenario
version: 0.6
title: Shape of scenario kernel records
layer: L2
type: schema
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [procedure-author, reviewer]
stages: [any]
triggers: [stage-3-start, scenario-gap]
inputs: [.ai/core/schema/procedure.schema.md, .ai/core/L0-meta/P-L0-001-procedure-lifecycle.md]
outputs: [record-draft, review-report]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [C]
evidence: [PROTO-DEC-0054, PROTO-DEC-0061, PROTO-DEC-0075:6]
---

# Scenario schema

This schema defines the shape of every kernel scenario record.

## Purpose

A scenario is a composite procedure that orchestrates multiple procedures through a stage graph.

## Rules

R-L2-scenario.1. Every scenario MUST conform to SCHEMA-procedure.
R-L2-scenario.2. Every scenario MUST have Stage graph and Handoff artifacts sections.
R-L2-scenario.3. Every node MUST state completion criterion per PROTO-DEC-0075 item 6.

## Steps

1. Define the scenario structure
2. Add Stage graph section
3. Add Handoff artifacts table
4. Validate against SCHEMA-procedure

## Stage graph

Scenarios contain a directed acyclic graph of stages with artifact-based transitions.

## Handoff artifacts

| Artifact | Producer | Consumer | Check | Validator |
|---|---|---|---|---|
| TBD | TBD | TBD | TBD | TBD |

## Stop conditions

Stop when a transition has no artifact in the Handoff artifacts table.

## Back edges

Scenarios list back edges as <from>><to>/<budget>/<exit>.

## Evidence

- C - Derived from  and PROTO-DEC-0075; metric: M-012 (FORWARD REFERENCE - not yet in
  the L6 registry M-001..M-011; LCC pending; definition: adoption rate by stage-4 packages; S5-T06
  candidate); kill: two consecutive stages reject the schema; deadline: S3-T11 review

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Incomplete artifacts | medium | high | Handoff artifacts table | author | missing artifact |

## Change log

- 0.1 — 2026-09-29
- 0.2 — 2026-09-29
- 0.3 — 2026-09-29
- 0.4 — 2026-10-03
- 0.5 — 2026-10-04
- 0.6 — 2026-10-05
