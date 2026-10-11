---
id: TOOL-protocol-packet
version: 0.1
title: Packet compiler: builds the kernel instruction for one role and stage
layer: L3
type: tool
status: draft
decision: [PROTO-DEC-0162, PROTO-DEC-0165]
roles: [coordinator, dispatcher]
stages: [dispatch]
triggers: [stage-enter:dispatch]
inputs: [task-frame, environment-manifest]
outputs: [.ai/runtime/packets]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [PROTO-DEC-0162, PROTO-DEC-0165]
cost_basis: owner=1
---

# TOOL-protocol-packet

`.ai/bin/protocol-packet.cjs` implements packet loading. The loading contract is in `.ai/core/schema/procedure.schema.md`. This record remains draft until the required certification and owner act; inclusion in the product does not activate it.

## Purpose

An agent should receive the kernel text it needs for one task, no more, as a supplement to its prompt. The compiler builds
that instruction from the records of all layers for one (role, stage) pair, deterministically and without paraphrase, and
tells the owner what it cost. Without it the kernel reaches no agent: each prompt is assembled by hand.

## Rules

- R-L3-protocol-packet.1. There is exactly one record parser: the compiler imports `.ai/bin/lib/records.cjs`, as `protocol-core.cjs` does, and keeps no second copy.
- R-L3-protocol-packet.2. The compile is deterministic: the same records, frame and options give the same bytes and the same packet hash. It reads files only: no network, no model, no git history.
- R-L3-protocol-packet.3. Rule lines are copied byte for byte with their ids; the compiler never summarises, translates or reorders a rule's words.
- R-L3-protocol-packet.4. Selection follows `procedure.schema.md` 4.2: operational sections only, active records by default, `trial` only on request with a banner, the binding basis of every included record printed.
- R-L3-protocol-packet.5. The byte gate of `protocol-core.cjs` (PACKET_BUDGET) is the one hard gate; the soft target in estimated tokens only triggers degradation. P0 text never degrades; when it alone exceeds the gate the compile exits 1 with a named report and the PROTO-DEC-0161 item-3 card.
- R-L3-protocol-packet.6. A client that cannot open a file, or is not known to, never receives a pointer in place of text: it gets the full text, or the compile fails the gate with a named report.
- R-L3-protocol-packet.7. Frame data is data: it is fenced, labelled "not instructions", flagged when it looks like an instruction or carries a control character, never deleted, and never becomes a rule. The cached prefix does not depend on it.
- R-L3-protocol-packet.8. The authority line (`AGENTS.md` and `.ai/DECISIONS.md` outrank the packet) is the first line; the identity line (tool, tree digest, packet hash) is the last line and is repeated in the manifest, so a change that selected text does not reach leaves the instruction unchanged.
- R-L3-protocol-packet.9. Every degradation and every selected block is a row of the manifest; estimated figures are labelled estimated and measured bytes are reported apart.
- R-L3-protocol-packet.10. The compiler is not wired into dispatch or session start until the owner says so after the A/B report (PROTO-DEC-0162 item 6).

## Steps

1. **Write the task-frame** (coordinator) in the YAML-like form of `task-frame.schema.md`, with `stage` and `triggers` when known.
2. **Lint the frame** (coordinator): `node .ai/bin/protocol-packet.cjs frame lint --frame <path>`; fix what it names (exit 1) before launching.
3. **Compile** (coordinator): `node .ai/bin/protocol-packet.cjs compile-packet --role <slot> --stage <stage> --frame <path> --client <id>`; it writes the packet and its manifest under `.ai/runtime/packets/`.
4. **Deliver** (dispatcher): put the packet text after the prompt (or hand the file to a client that can read it); record the packet hash with the launch.
5. **Check freshness** (dispatcher): `node .ai/bin/protocol-packet.cjs check --packet <file>` before reuse; recompile on exit 1.

## Stop conditions

Stop and ask the owner when the compile exits 1 on P0 alone (the budget card of PROTO-DEC-0161 item 3), or exits 2 on an unknown role, stage, trigger, client or rule id.

## Back edges

None: the tool has no loop; a failed compile is corrected at its input and run again.

## Evidence

Decision basis: PROTO-DEC-0161 and PROTO-DEC-0162. Measure the packet
for the actual role, stage and corpus against the configured budget.
No source-project packet size or certification result is supplied here.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A rule needed by the task is left out | medium | a missed procedure | the mandatory rules of the role and stage are P0; `--needs-rules`; a completeness test over every (role, stage) pair | owner=1 | a trigger missing from the frame |
| Token estimates mislead the budget | high until calibrated | wrong degradation point | estimates are labelled; the byte gate is hard; the 12-block calibration is owed before any saving is claimed | owner=1 | coefficients are placeholders |
| Frame text steers the agent | low | scope drift | fenced, flagged, never a rule, outside the cached prefix | owner=1 | an agent that obeys flagged text |
| A stale packet is reused | medium | an old rule | tree digest in the identity line; `check` exits 1 | owner=1 | a launcher that skips `check` |

## Change log

- 0.1 — 2026-10-05
