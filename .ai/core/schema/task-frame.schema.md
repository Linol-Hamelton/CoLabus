---
id: SCHEMA-task-frame
version: 0.7
title: Shape of the task-frame artifact (L5)
layer: L5
type: schema
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator, implementer, reviewer]
stages: [frame, execute, accept, triage, dispatch]
triggers: [task-intake, frame-gap, source-missed]
inputs: [task-intake-record, CATALOG]
outputs: [task-frame]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0054, PROTO-DEC-0075:6]
---

# Task-frame schema

This schema defines the task-frame artifact consumed by the workflow procedures and dispatcher.

## Purpose

The task-frame establishes what the task intends to achieve, what it explicitly excludes,
what it may change, what it must not touch, and the constraints under which it operates.
The frame prevents work based on unverified sources or incorrect scope boundaries.

## Rules

- R-L5-task-frame.1. Every task-frame MUST be a YAML-like file with the exact fields below.
- R-L5-task-frame.2. Every field listed below with Required `yes` MUST appear exactly once in every task-frame; a field with Required `no` appears at most once.
- R-L5-task-frame.3. The `sources` field MUST have inventory status on every entry (`tracked|untracked|missing`).
- R-L5-task-frame.4. The `scope-id` MUST match the grammar `kind:name` from SCHEMA-assignment §2.
- R-L5-task-frame.5. The `forbidden` field MUST include all paths from PROTOCOL.md and all
paths of exhausted root causes.
- R-L5-task-frame.6. The `risk` field MUST be one of the classes defined in PROTO-DEC-0038.
- R-L5-task-frame.7. The `tier` field value MUST come from P-L2-002 output.
- R-L5-task-frame.8. The `scope-registry` artifact MUST be the one scope registry of the project and MUST list
all issued scope-ids with their frame paths and parent scope-ids (SCHEMA-assignment §3).
- R-L5-task-frame.9. If a task-frame declares an implementation block breakdown, each block MUST declare the nine mandatory fields: ID, requirement/invariant, input baseline, touched paths, dependencies, positive test, negative test, reviewer, closure condition.

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `goal` | string | yes | One sentence describing verifiable success |
| `non-goals` | list of strings | yes | Explicit exclusions; empty if none |
| `sources` | list of strings | yes | Each: `tracked|untracked|missing` per R-L0-16 |
| `baseline` | string | yes | Full commit SHA at frame creation |
| `scope-id` | string | yes | Unique id in form `kind:name` |
| `parent-scope` | string | yes | Parent scope-id or `-` |
| `scope` | list of strings | yes | Paths or globs that may be edited |
| `forbidden` | list of strings | yes | Paths or globs that may NOT be touched |
| `risk` | string | yes | Risk class per PROTO-DEC-0038 |
| `tier` | string | yes | Tier from P-L2-002 (T1..T9) |
| `success` | list of strings | yes | Acceptance criteria, each verifiable |
| `budgets` | object | yes | `attempts`, `idle`, `wakes`, `cap` as integers |
| `stage` | string | no | The stage id (`procedure.schema.md` 2.2) the task runs in; read by `compile-packet`. With `--stage` on the command line both must agree, else exit 2 |
| `triggers` | list of strings | no | Trigger tokens already fired for this task, each in the `triggers` dictionary of `procedure.schema.md` section 6; they open the records whose pointer names them. With `--triggers` both must agree, else exit 2 |

### Block declaration fields (when block breakdown is used)

| Field | Type | Required | Description |
|---|---|---|---|
| `ID` | string | yes | Block identifier |
| `requirement/invariant` | string | yes | Verifiable contract or invariant |
| `input baseline` | string | yes | Commit SHA or tree baseline |
| `touched paths` | list of strings | yes | Exact paths modified by this block |
| `dependencies` | list of strings | yes | Prior block IDs or external prerequisites |
| `positive test` | string | yes | Command demonstrating expected functionality passes |
| `negative test` | string | yes | Command demonstrating invalid/adversarial input is rejected |
| `reviewer` | string | yes | Assigned reviewer role |
| `closure condition` | string | yes | Checkable proof of closure |

## Steps

1. Coordinator writes task-frame with all required fields.
2. Lint validates each field against this schema.
3. If validation fails, frame is rejected and must be corrected.
4. Validated task-frame is handed to P-L2-006 for dispatch.

## Stop conditions

Stop when: a required field is missing; a field value violates its grammar; sources list
has no inventory status; scope-id format invalid.

## Back edges

None. A schema itself has no back edges; failures return to the producing procedure.

## Evidence

- B - The record specifies an explicit field set with inventory-checked sources.
  This product document does not include the incident dossier or assert an
  independently measured improvement.
- C - Source verification rule closes the missed-source class; trial: M-012 forward reference
  (LCC pending; definition: adoption rate by stage-4 packages; a candidate)

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Missing required field | medium | high | schema validation | lint | frame rejected before use |
| Invalid scope-id | low | medium | grammar check | lint | format error caught |
| Sources not verified | high | high | R-L5-task-frame.3 | coordinator | missed source in L5 |
| Forbidden list incomplete | medium | high | R-L5-task-frame.5 default | dispatcher | exhausted paths not blocked |

## Change log

- 0.3 — 2026-10-04
- 0.1 — 2026-09-29
- 0.2 — 2026-09-29
- 0.4 — 2026-10-04
- 0.5 — 2026-10-05
- 0.6 — 2026-10-05
- 0.7 — 2026-10-05
