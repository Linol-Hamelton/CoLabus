---
id: P-L2-006
version: 0.5
title: Task and session dispatch
layer: L2
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0162, PROTO-DEC-0165]
roles: [coordinator]
stages: [dispatch]
triggers: [stage-enter:dispatch]
inputs: [task-frame, environment-manifest]
outputs: [task-frame]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0041:1, PROTO-DEC-0047, PROTO-DEC-0061]
cost_basis: unknown
---

# P-L2-006 Dispatch

The record metadata declares its status, applicability and approval basis.

## Purpose

Govern task delegation and CLI/agent dispatch without loss of governance invariants, unverified authority transfer, or self-certification.

## Rules

- R-L2-006.1. A dispatch is an operational launch, not a delegation or transfer of authority; governance boundaries remain fixed.
- R-L2-006.2. Every dispatched assistant starts its own session, writes exclusively to its own dedicated session journal, and produces its own evidence records.
- R-L2-006.3. Console stdout, terminal logs, and chat messages do not constitute Evidence; only tamper-evident receipts signed by `protocol-handoff.cjs record` bind.
- R-L2-006.4. The dispatching coordinator that formulated the prompt or shaped execution is barred from certifying the resulting candidate (PROTO-DEC-0041 item 1).
- R-L2-006.5. Dispatch must provide the exact `task-frame` and `environment-manifest`; the dispatched assistant inherits only the declared tools and scope.
- R-L2-006.6. Background agent processes: Background agent processes for long-running tests and tools must run persistent, surviving process group and session window transitions.
- R-L2-006.7. When the owner has wired the packet compiler (after the A/B report, PROTO-DEC-0162 item 6), step 1 compiles the instruction for the assignee's (role, stage) pair with `protocol-packet.cjs compile-packet`, the launch delivers it as a supplement to the prompt, the launch record carries its packet hash, and a launch without a packet hash is refused. Until then the packet is optional and its hash, when one is used, is recorded.

## Steps

1. **Prepare Dispatch Envelope** (coordinator). Assemble the task frame, environment manifest, and assigned role slot; when the compiler is wired, compile the instruction packet for the pair (R-L2-006.7).
2. **Execute Dispatch Call** (coordinator). Invoke the target assistant CLI or hook with designated parameters and working directory.
3. **Verify Session Identity** (coordinator). Confirm the dispatched assistant started an independent session and unique worklog.
4. **Collect Results** (coordinator). Await completion; verify that outputs are persisted in repository artifacts rather than relying on terminal stdout.

## Stop conditions

- Target assistant cannot be launched with required tool permissions.
- Dispatched assistant attempts to write to caller's worklog.
- Authority transfer is requested without explicit human owner directive.

## Back edges

None; dispatch initiates execution and yields control until completion or error signal.

## Evidence

- A - PROTO-DEC-0041:1: Controller cannot certify what it directed or controlled.
- B - PROTO-DEC-0047: Standardized CLI dispatch and independent session contracts.
- B - PROTO-DEC-0061: Stage 1 procedure baseline for operational execution.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Caller certifies dispatched work | low | critical | Independence rule (R-L2-006.4) | gate check | none |
| Dispatched session overwrites caller state | low | high | Dedicated session journal (R-L2-006.2) | path check | none |
| Terminal text mistaken for Evidence | medium | high | Formal evidence requirement (R-L2-006.3) | receipt check | none |

## Change log

- 0.2 — 2026-10-04
- 0.1 — 2026-10-04
- 0.3 — 2026-10-04
- 0.4 — 2026-10-05
- 0.5 — 2026-10-05
