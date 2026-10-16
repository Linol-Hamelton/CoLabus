---
id: P-L3-001
version: 0.2
title: Tool governance - TOOL records, ownership and lifecycle of protocol tools
layer: L3
type: procedure
status: active
owner_approval: PROTO-DEC-0184
decision: [PROTO-DEC-0184]
roles: [all]
stages: [any]
triggers: [signal:procedure-gap, owner-directive, tool-change, tool-invoked]
inputs: [CATALOG, .ai/core/EXTERNAL-PENDING.md, .ai/core/schema/procedure.schema.md]
outputs: [record-draft, CATALOG, journal]
tools: [TOOL-protocol-core, TOOL-protocol-index, TOOL-protocol-ledger]
back_edges: []
enforcement: S~
enforced_by: [.ai/bin/protocol-core.cjs]
script_candidate: no:4
evidence_class: [A]
evidence: [.ai/core/RULE-MAP.md:72, AGENTS.md:378, PROTO-DEC-0034, PROTO-DEC-0044, PROTO-DEC-0047:8, PROTO-DEC-0047:11, PROTO-DEC-0061, PROTO-DEC-0146, PROTO-DEC-0159, .ai/core/schema/procedure.schema.md:51]
---

# P-L3-001 Tool governance

This record remains draft. Activation and binding effect require the separate owner act. The mechanical checks cover tool-id grammar, reference resolution and registry reconciliation. They do not prove one record per script: that property requires CATALOG inspection and review. Deciding whether a tool needs a record or should be retired remains judgement.

## Purpose

This procedure governs tool identification, records, ownership and retirement.
Every named tool has one TOOL record; external tooling remains advisory and never
becomes Evidence or a gate input. The record states the tool contract.

## Rules

- R-L3-001.1. A protocol tool the kernel names carries the id form `TOOL-<name>` (FACT .ai/core/schema/procedure.schema.md:51), and exactly one TOOL record of `type: tool` and `layer: L3` homes it - never two (the layer test: L3 if it describes a tool, FACT .ai/core/L0-meta/P-L0-001-procedure-lifecycle.md:74). Exact-one is a norm of this procedure, not a gate: no check rejects a second record for the same script today, so it is held by the CATALOG search at intake and by review; the mechanical check is OPEN.
- R-L3-001.2. A TOOL record is created, changed, superseded and retired only through P-L0-001: its id is permanent and never reused, its status is one of the schema's status enumeration, and a retired record's text moves to the archive with the id reserved and a CATALOG pointer.
- R-L3-001.3. The scripts of the recorded tools live in `.ai/bin/` of the protocol source repository and reach a host project only through the installer's managed list - `managed` is the single definition of what the protocol owns and ships (FACT protocol-manifest.json:2; DEC-0013). Whether a host project may edit its local copy is settled by no recorded decision - the installer itself preserves host modifications to existing managed files (FACT .ai/docs/PROTOCOL.md:405-407) - and stays OPEN here.
- R-L3-001.4. External tools and MCP output are advisory only - never Evidence and never a gate input - and forced use applies only to the protocol's own deterministic tools and procedural lookups (FACT AGENTS.md:378; PROTO-DEC-0034 item 2; PROTO-DEC-0047 item 11).
- R-L3-001.5. A tool whose output is derived (the index, the ledger) defaults its output under `.ai/runtime/`, where it is disposable and never a source of truth (PROTO-DEC-0044 item 4); confining every output path there is the norm, but no script enforces it today (`--out` writes anywhere, see TOOL-protocol-ledger) - an OPEN gap, not an implemented contract.
- R-L3-001.6. A TOOL record states the real contract of the real script - commands, exit codes, outputs, determinism, the decisions it enforces - with per-line provenance, and where the script does not yet meet the script standard's fail-closed rule (unknown input exits 2, never guessed; PROTO-DEC-0047 item 8), the record carries that gap as an explicit OPEN limitation instead of describing it as implemented behavior.
- R-L3-001.7. A reference to a TOOL id no record resolves passes a gate only as an open row of the EXTERNAL-PENDING registry (FACT .ai/core/EXTERNAL-PENDING.md:3-4), a row whose reference resolves is closed in the same change that resolves it, and closing a row whose referrer is a record of a frozen layer is a separately authorized write-set (FACT ).
- R-L3-001.8. When a tool launches, measures or dispatches a client, the model, effort and permission data come from the client registry through P-L3-005, and a TOOL record never restates client data (PROTO-DEC-0047 item 9; P-L3-005 rule R-L3-005.1).
- R-L3-001.9. A governed tool without a TOOL record - today the archive, dispatch, hooks, validate, listener, lock, session, handoff and signal scripts of `.ai/bin/`, and the planned stage-6 packet compiler (PROTO-DEC-0165) - passes the gates only the way LCC-5 allows every unrecorded id: as a reference declared pending with its stage (FACT .ai/core/L0-meta/P-L0-004-layer-consistency.md:53), as an open EXTERNAL-PENDING row (R-L3-001.7), or by its script path; prose that treats an unrecorded id as a recorded tool is a defect, and each such record is OPEN until an owner-authorized act writes it through this procedure.

## Steps

Actor slots are L1's: any agent records a trigger; the procedure-author drafts; the reviewer opposes; the owner decides.

1. **Intake** (any agent). A trigger arrives: a new tool, a changed tool contract, a `signal:procedure-gap` naming a tool, or an owner directive. Record the trigger in the journal and search CATALOG for an existing TOOL record by id, title and triggers (P-L0-001 step 1). Output: a journal intake line.
2. **Classify** (procedure-author). Confirm it is a protocol tool: a deterministic script with a stable command-line contract that the kernel or a gate can invoke. One tool, one record; a script with several subcommands under one contract stays one tool (TOOL-protocol-core is the precedent). Two candidate homes for one tool, or a rule that belongs to another layer, go to the owner (P-L0-002). Output: the classification line in the journal.
3. **Dossier and draft** (procedure-author). Collect the real script's header, commands, exit codes and the recorded decisions it enforces; draft the TOOL record to SCHEMA-procedure through P-L0-001 steps 3-4, `status: draft`, every non-obvious claim carrying its FACT path:line. Output: the draft record.
4. **Registry** (procedure-author). Add open EXTERNAL-PENDING rows for references that stay external - id grammar permitting; a reference the row grammar cannot express is recorded as OPEN in the journal, never forced into a malformed row - and close the rows this change resolves (R-L3-001.7). Output: the registry diff in the same candidate.
5. **Review and activation** (reviewer, then owner). P-L0-001 steps 7-10: adversarial review by a non-author with closed verdicts, owner approval, a trial where the class requires it, then publication. A TOOL record binds only at `status: active` with its `owner_approval`. Output: the review report and the published record.
6. **Live and retire** (coordinator). At batch planning run P-L0-006; deprecation and retirement follow P-L0-001 step 11 and need the P-L0-007 comparative test - disuse alone never counts. A deprecated tool keeps its record with the new status; a retired tool's text moves to the archive and its id stays reserved. Output: the change-log line and the CATALOG pointer.

## Stop conditions

Stop and go to P-L0-002 when:

- a candidate tool is not deterministic, or would put the network or a model in a gate path (PROTO-DEC-0047 item 8, fail closed);
- the change would make external tool output Evidence or a gate input (R-L3-001.4; FACT AGENTS.md:378);
- two homes claim one tool, or the record would carry rules owned by another layer (the layer test, P-L0-001 step 2);
- a reference the registry row grammar cannot express is the only way forward (record it OPEN; do not force a malformed row);
- closing a frozen layer's registry row would happen without its separately authorized write-set (R-L3-001.7).

## Back edges

None. The drafting, review, trial and re-entry loops are owned by P-L0-001 and apply here through its steps; this procedure adds no loop of its own.

## Evidence

Decision basis: PROTO-DEC-0061, PROTO-DEC-0044, PROTO-DEC-0047 items 8
and 11, and PROTO-DEC-0034 item 2. The tool record is a contract; external
tooling stays advisory and never becomes Evidence or a gate input.
This document supplies no historical audit outcome or session-cost measurement.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A TOOL record drifts from the real script | medium | high | per-line provenance (FACT path:line) and review against the live script header | reviewer time | a record that documents an intent, not the tool |
| One tool gets two records, or two tools share one | low | medium | R-L3-001.1 exact-one as a norm; CATALOG search at intake and review (mechanical check OPEN) | one classify step | a split the reviewer judges differently |
| An unrecorded tool is cited by an invented `TOOL-` id | medium | medium | R-L3-001.9: pending with its stage, registry row or script path; the LCC-5 pending path (FACT .ai/core/L0-meta/P-L0-004-layer-consistency.md:53); review | one gate run | prose that names a tool without checking CATALOG |
| A registry row goes stale after its reference resolves | medium | medium | R-L3-001.7 close-in-same-change; the stale row fails the layer gates | one registry edit | a closed row whose reference later disappears again |
| Drafts are treated as binding before the owner's act | medium | high | `status: draft` and the F8 rule (active requires owner_approval); this record's own status | none | a draft cited as authority |

## Change log

- 0.1 — 2026-10-05
- 0.2 — 2026-10-14
