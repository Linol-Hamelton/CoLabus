---
id: SCHEMA-task-context
version: 0.1
title: Shape of the task-context artifact: the architecture context of one task for the packet compiler
layer: L5
type: schema
status: draft
roles: [implementer, fixer, certifier, reviewer]
stages: [execute, accept]
triggers: [path-owner]
inputs: [.ai/core/schema/procedure.schema.md, docs/ops/COUPLED-SETS.json]
outputs: [.ai/core/schema/task-context.schema.md]
back_edges: []
enforcement: S
enforced_by: [.ai/bin/lib/task-context.cjs, .ai/bin/protocol-context.cjs, .ai/bin/protocol-packet.cjs]
script_candidate: yes
evidence_class: [B]
cost_basis: unknown
evidence: [PROTO-DEC-0187:1]
---

# Task-context schema

The document `task-context/1` that the context resolver (`.ai/bin/protocol-context.cjs resolve`) writes and the packet compiler
(`compile-packet --context`, procedure.schema.md 4.5) reads. One shape, one level filter and one rendering live in
`.ai/bin/lib/task-context.cjs`; the resolver and the compiler both use them.

## Purpose

An author or a certifier who receives only the rules of a role and a stage writes and checks a change without the architecture around it:
the records that own the changed paths, their processes, decisions, consumers, tests, contracts, the earlier rounds of the package and the
findings already raised on those paths. The document carries that context as data derived from one commit, so two seats of one role on one
task get one packet and the context can be checked against the head it was built from.

## Rules

- R-L5-task-context.1. A task-context document MUST be derived only from the git objects of one commit, the bytes of the task file and the bytes of the frame; never from the working tree, the environment, the clock, randomness, the network, a search server or an index whose inputs differ from the commit.
- R-L5-task-context.2. A task-context document MUST carry exactly the keys of the Fields table in that order, every row of a section MUST carry exactly the fields of its section in that order, and every value MUST keep its grammar; the rows of a section are sorted and unique, and the file is the canonical serialisation of its value.
- R-L5-task-context.3. A row MUST carry only repository-relative paths, record, decision, process and rule ids, object ids, closed words and one commit subject; a row whose value carries a machine path, a credential shape or a value outside its grammar is left out by the resolver and counted in `dropped`.
- R-L5-task-context.4. An absent source of the repository MUST be written as a `sources` row with state `absent`; an empty section means that no row was found in the sources that exist, never that the source is missing.
- R-L5-task-context.5. The level of a document MUST be the largest of C3, C2 and C1, at or below the requested one, whose rendering keeps the byte limit of the level; the floor C1 is never cut.
- R-L5-task-context.6. A compiler MUST deliver a task-context document only while the coupled-set registry of its commit switches the packet context on, and MUST refuse a document that breaks R-L5-task-context.2 by name.
- R-L5-task-context.7. A compiler MUST open through the trigger `path-owner` only the owners of the bases `self`, `tool-name`, `enforced-by`, `outputs` and `inputs`; an owner of the basis `evidence` or `text` stays a data row of the context.

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `schema` | string | yes | `task-context/1` |
| `switch` | string | yes | `off` or `on`: the packet context switch of the coupled-set registry of the commit (absent registry: `off`) |
| `commit` | string | yes | full object id of the candidate commit |
| `tree` | string | yes | full object id of its tree |
| `base` | string | yes | full object id of the base commit the branch is compared with |
| `stream` | string | yes | the stream (branch) of the package |
| `package` | string or null | yes | the package name, when given |
| `launchRole` | string | yes | `author` or `certifier` |
| `taskSha256` | string | yes | `sha256:` and 64 hex of the task file bytes |
| `level` | string | yes | `C3`, `C2` or `C1` |
| `targets` | list | yes | `path`, `basis` (`task-scope`, `task-mention`, `branch-diff`), `blob` (object id or null for a path the commit removed) |
| `owners` | list | yes | `path`, `record`, `status`, `basis` (`self`, `tool-name`, `enforced-by`, `outputs`, `inputs`, `evidence`, `text`; the strongest one per record) |
| `processes` | list | yes | `path`, `process` (a row of the process register naming the path), `basis` `register-row` |
| `rules` | list | yes | `record` (an owner), `rule` (a row of the rule map whose home names it), `basis` `rule-map` |
| `decisions` | list | yes | `path`, `id` (an Accepted block of the commit), `basis` (`decisions-index`: the block binds the path; `owner-record`: an owner names it) |
| `consumers` | list | yes | `path`, `consumer` (a code reader of the commit, not a test), `depth` (1 or 2), `basis` `grep-at-commit` |
| `tests` | list | yes | `path`, `test`, `tier` (`light`, `heavy-farm`, `unmeasured`), `basis` (`consumer-index` when its inputs equal the commit, else `grep-at-commit`) |
| `contracts` | list | yes | `path`, `doc` (a specification of the commit citing the path), `basis` `cites-path` |
| `history` | object | yes | `package` (`commit`, `subject`, `basis` `branch-log`, first-parent order), `reports` (`doc`, `basis` `author-report` or `review-name`), `findings` (`review`, `id`, `severity`, `status`, `path` or null, `class`, `basis` `review-cites-path` or `review-name`) |
| `coupledSets` | list | yes | `id`, `basis` (`stream`, `package`, `path-mask`), `members` (the path masks of the set) |
| `sources` | list | yes | `name`, `file`, `sha256` or null, `state` (`used`, `stale`, `absent`), `reason` or null |
| `dropped` | list | yes | `section`, `rows`, `reason` (`level C2`, `level C1`, `machine-path`, `secret-shape`, `value-form`, `scope-glob-wide`) |

## Levels

| Level | Limit of the rendered section | Rows |
|---|---:|---|
| C3 | 24000 bytes | every row |
| C2 | 12000 bytes | as C3, but consumers of depth 1 only; of the tests the ones of tier `heavy-farm` or `unmeasured` and the ones that are targets; of the findings the ones of the same package and the severe ones (CRITICAL, BLOCKER, HIGH, MAJOR, MEDIUM) |
| C1 | the room under the byte gate | targets, owners, decisions, coupled sets, the findings of the same package; sources and dropped stay at every level |

The compiler re-decides the level for the room the instruction leaves under the one byte gate of the packet (PROTO-DEC-0187 item 1) and never
goes above the level of the document.

## Evidence

- B - Fix rounds that each found a new defect class next to the fixed line, because the author saw the rules of the role and not the
  architecture around the change; old version: none (first implementation); difference: the context of the task is derived from the
  commit and delivered, not written by hand; worse: n/a (first version).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A false owner by a mention in a record text | medium | low | `basis` per row, `text` the weakest | resolver | the author reads one record more |
| Context swallows the room of the instruction | medium | medium | levels C3 to C1, the floor refusal | compiler | a refused compile names the largest sections |
| A context built for another head | medium | high | `check` against the head | caller | none when the caller checks |
| Injection through review text | low | high | ids, paths and object ids only; one subject line; detectors before the compiler | resolver | a subject line inside the data fence |

## Change log

- 0.1 — 2026-11-12
