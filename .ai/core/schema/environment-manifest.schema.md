---
id: SCHEMA-environment-manifest
version: 0.4
title: Shape of the environment-manifest artifact (L5)
layer: L5
type: schema
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [coordinator, implementer, dispatcher, reviewer]
stages: [frame, dispatch, execute, accept, triage]
triggers: [frame-gap, tool-blocked, capability-missed]
inputs: [task-frame, TOOL-registry]
outputs: [environment-manifest]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0031, PROTO-DEC-0047:7, PROTO-DEC-0054]
---

# Environment-manifest schema

This schema defines the environment-manifest artifact read by the dispatcher to grant narrow tool permissions.

## Purpose

The environment-manifest declares exactly which tools, capabilities, and client settings
a task may use. A tool not in the manifest must not be used; a blocked tool stops to P-L0-002, not bypassed.

## Rules

R-L5-environment-manifest.1. Every environment-manifest MUST be a YAML-like file with the
exact fields below.
R-L5-environment-manifest.2. Every field listed below MUST appear exactly once.
R-L5-environment-manifest.3. Every tool in `tools` MUST be a valid TOOL-* id from the TOOL
registry.
R-L5-environment-manifest.4. Every capability in `capabilities` MUST be from PROTO-DEC-0031
(FS_WRITE, SHELL_EXEC, REPO_READ, EVIDENCE_SIGN).
R-L5-environment-manifest.5. The `tools` list MUST include every tool the task will use;
one not listed MUST NOT be used.
R-L5-environment-manifest.6. The dispatcher (L3) reads this manifest to grant only the listed
rights (PROTO-DEC-0047 item 7).

## Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `tools` | list of strings | yes | TOOL-* ids the task may invoke |
| `client-rights` | list of strings | yes | Capability ids from PROTO-DEC-0031 the client must have |
| `client-flags` | object | yes | Key-value pairs from client profile that affect behavior |
| `capabilities` | list of strings | yes | The four capability bits: FS_WRITE, SHELL_EXEC, REPO_READ, EVIDENCE_SIGN |

## Steps

1. Coordinator writes environment-manifest with all required fields.
2. Lint validates each field against this schema and checks every tool id exists in
TOOL registry.
3. If validation fails, manifest is rejected and must be corrected.
4. Validated environment-manifest is handed to P-L2-006 for dispatch.
5. Dispatcher reads manifest and grants only listed rights to implementer.

## Stop conditions

Stop when: a required field is missing; a tool id is not in TOOL-* registry; capability
list contains an unknown capability; client-rights reference invalid.

## Back edges

None. A schema itself has no back edges; failures return to the producing procedure.

## Evidence

The explicit tool and capability fields constrain unknown permissions.
Trial: M-012 is a forward reference (LCC pending; definition: adoption rate by
stage-4 packages; a candidate). No incident measurement is supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Tool not in registry | medium | high | R-L5-environment-manifest.3 | lint | tool use blocked at lint |
| Capability unknown | low | medium | R-L5-environment-manifest.4 | lint | capability error caught |
| Tool used not in manifest | medium | high | R-L5-environment-manifest.5 | dispatcher | P-L0-002 stop |
| Dispatcher ignores manifest | low | high | R-L5-environment-manifest.6 | auditor | permission leak |

## Change log

- 0.1 — 2026-09-29
- 0.2 — 2026-09-29
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
