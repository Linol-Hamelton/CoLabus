---
id: P-L2-001
version: 0.7
title: Task frame and environment manifest
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0162, PROTO-DEC-0165]
roles: [coordinator, implementer]
stages: [frame, triage, dispatch]
triggers: [task-intake, frame-gap, scope-exceeded]
inputs: [task-intake-record, CATALOG, signals, .ai/TASK.md]
outputs: [task-frame, environment-manifest]
tools: [TOOL-protocol-core, TOOL-protocol-index]
back_edges: [4>2/1/owner]
enforcement: none
script_candidate: no:4
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0054, PROTO-DEC-0075:6]
---

# P-L2-001 Task frame and environment manifest

The record metadata declares its status, applicability and approval basis.

## Purpose

The task frame and environment manifest establish the boundaries, goals and tooling
permissions for a task. Verified source inventory prevents scope assumptions;
explicit environment declarations prevent unknown permissions from becoming a bypass.

## Rules

- R-L2-001.1. Every task MUST have a task-frame artifact before execution begins.
- R-L2-001.2. Every task MUST have an environment-manifest artifact that names every tool it uses.
- R-L2-001.3. A tool not in the environment-manifest MUST NOT be used; if used, stop to P-L0-002.
- R-L2-001.4. The task-frame `sources` list MUST be checked against the repository inventory
( §4, R-L0-16); each source line carries `tracked|untracked|missing`.
- R-L2-001.5. The `scope-id` MUST be in the form `kind:name` from the assignment grammar
( §4).
- R-L2-001.6. The `scope` field lists the paths that may be edited; the `forbidden` field lists
paths that may not be touched, defaulting to PROTOCOL.md paths plus exhausted-cause paths
( §6).
- R-L2-001.7. The environment-manifest is read by the dispatcher (L3) to grant narrow permissions
(PROTO-DEC-0047 item 7).
- R-L2-001.8. Block declaration fields: When a task is partitioned into implementation blocks, each block is the coherent change of one verifiable contract and must declare the nine mandatory fields: ID, requirement/invariant, input baseline, touched paths, dependencies, positive test, negative test, reviewer, closure condition. Shared engine contracts must not be split across blocks.
- R-L2-001.9. A task-frame may carry the optional fields `stage` and `triggers` (task-frame.schema.md); the packet compiler reads them, and a value that differs from the command line is exit 2. Before launch `protocol-packet.cjs frame lint` checks the frame for completeness; when the compiler is wired (PROTO-DEC-0162 item 6) a frame that fails the lint is corrected, not launched.

## Steps

1. **Receive intake** (coordinator). Input: `task-intake-record` from Intake (S-001 node 1).
   Output: task intake acknowledged.
2. **Write task-frame** (coordinator). For each field in  §4:
   - `goal`: one sentence, verifiable
   - `non-goals`: explicit exclusions
   - `sources`: list with inventory status per R-L2-001.4
   - `baseline`: `git rev-parse HEAD` at frame creation
   - `scope-id`: issued by owner or coordinator, unique per frame
   - `parent-scope`: parent scope-id or `-`
   - `scope`: editable paths
   - `forbidden`: blocked paths
   - `risk`: class per PROTO-DEC-0038
   - `tier`: from P-L2-002 output
   - `success`: acceptance criteria
   - `budgets`: attempts, idle, wakes, cap
   Output: `task-frame` artifact, validated against task-frame.schema.md.
3. **Write environment-manifest** (coordinator). List:
   - `tools`: TOOL-* ids required
   - `client-rights`: capability ids from PROTO-DEC-0031
   - `client-flags`: profile flags from client config
   - `capabilities`: the four capability bits (FS_WRITE, SHELL_EXEC, REPO_READ, EVIDENCE_SIGN)
   Output: `environment-manifest` artifact, validated against environment-manifest.schema.md.
4. **Verify artifacts** (coordinator). Run lint checks on both artifacts. If invalid, return
   to step 2 (back edge 4>2, budget 1, exit owner).
5. **Hand off** (coordinator). Publish `task-frame` and `environment-manifest` for dispatch
   (P-L2-006). Output: both artifacts available to implementer.

## Stop conditions

Stop to P-L0-002 when: a required field is missing; sources are not verified against inventory;
scope-id format is invalid; environment-manifest lists a tool not in TOOL-* registry;
back edge budget exhausted.

## Back edges

- 4>2/1/owner: invalid task-frame or environment-manifest returns to step 2 (write task-frame) once; a second
  failure goes to the owner.

## Evidence

Unverified sources, incorrect scope and unknown permissions can invalidate a task.
The schemas require explicit source inventory and environment declarations.
The product includes no incident dossier or historical probe result; those requirements
must be checked on the actual task and environment.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Unverified source list | high | high | R-L2-001.4 inventory check | coordinator | missed source passes to L5 |
| Missing tool in manifest | medium | high | R-L2-001.3 block | dispatcher | tool use stopped by lint |
| Scope too wide | medium | high | R-L2-001.6 forbidden list | reviewer | forbidden path edit caught |
| Frame not written | medium | medium | S-001 node 2 is mandatory | coordinator | task cannot start |
| Incorrect scope-id format | low | medium | R-L2-001.5 grammar check | lint | format error caught |

## Change log

- 0.1 — 2026-09-29
- 0.2 — 2026-09-29
- 0.4 — 2026-10-04
- 0.3 — 2026-10-03
- 0.5 — 2026-10-04
- 0.6 — 2026-10-05
- 0.7 — 2026-10-05
