---
id: P-L2-011
version: 0.4
title: Session journal logging, five-label format, and integrity
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
roles: [all]
stages: [session]
triggers: [action-complete, session-end]
inputs: [journal]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B]
evidence: [PROTO-DEC-0047, PROTO-DEC-0061]
cost_basis: unknown
---

# P-L2-011 Journal recording

The record metadata declares its status, applicability and approval basis.

## Purpose

Maintain auditable, tamper-evident operational logs by requiring unique session journals, mandatory five-label structure, and strict line bounds.

## Rules

- R-L2-011.1. Each active session writes to exactly one dedicated file in `.ai/worklog/`; writing to another session's journal is strictly forbidden.
- R-L2-011.2. Every journal entry must include all five mandatory labels: Agent, Action, Result, Next step, and Open. An entry omitting any label is rejected by the Stop hook.
- R-L2-011.3. Content honesty: an entry must explicitly state what changed, what was verified (with command and exit code), and what remains open; negative claims must remain verified.
- R-L2-011.4. `README.md` inside `.ai/worklog/` is a reference index, not a session journal.
- R-L2-011.5. Session journals are strictly bounded operational logs (maximum 150 lines); extended audits, syntheses, or reviews must be saved under `docs/reviews/` and referenced from the journal.
- R-L2-011.6. Reserve capacity check: Sessions must reserve journal capacity (<= 150 lines) before appending entries, archiving older entries as necessary.

## Steps

1. **Format Entry Header** (all). Create section heading `## YYYY-MM-DD - short title`.
2. **Populate Five Labels** (all). Write each of the five labels (Agent, Action, Result, Next step, Open) with factual operational evidence.
3. **Verify Line Limit** (all). Check that the journal file does not exceed the 150-line limit; if exceeded, archive older entries via `protocol-archive.cjs worklog`.
4. **Handoff Attachment** (all). Run `protocol-handoff.cjs record` to attach verifiable tree evidence to the completed entry.

## Stop conditions

- Journal file exceeds 150 lines without archival.
- Journal entry omits any of the five required labels.
- Attempting to modify another agent's journal file.

## Back edges

None; journal logging is append-only within the active session.

## Evidence

- B - PROTO-DEC-0047: Independent session worklogs and five-label completion gate requirements.
- B - PROTO-DEC-0061: Enforcement of journal bounds and auditability.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Journal file collision | low | critical | Unique session journal per owner (R-L2-011.1) | path isolation | none |
| Incomplete handoff entry | low | high | Five-label parser check (R-L2-011.2) | stop hook | none |
| Worklog size bloat | medium | medium | 150-line cap and archive tooling (R-L2-011.5) | validator | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
