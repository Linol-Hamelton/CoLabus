---
id: TOOL-protocol-index
version: 0.2
title: Addressable index of the decision log - advisory, derived, disposable
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0184
decision: [PROTO-DEC-0184]
roles: [all]
stages: [any]
triggers: [decision-lookup, owner-directive]
inputs: [.ai/DECISIONS.md]
outputs: [decisions-index]
back_edges: []
enforcement: S
enforced_by: [.ai/bin/protocol-index.cjs]
script_candidate: yes
evidence_class: [A]
evidence: [PROTO-DEC-0044, PROTO-DEC-0034, .ai/bin/protocol-index.cjs:3, .ai/bin/protocol-index.cjs:7, .ai/bin/protocol-index.cjs:10, .ai/bin/protocol-index.cjs:16]
---

# TOOL-protocol-index Addressable index of the decision log

This draft record describes the decision-index interface. Activation is a separate owner act.

## Purpose

The decision log is append-only and never trimmed, so it grows without bound while every reviewer
needs the norms in it; this tool removes the cost of re-reading it to find which decision binds one
file, without ever letting a derived index become a second source of truth (FACT .ai/bin/protocol-index.cjs:5;
PROTO-DEC-0044 item 2).

## Rules

- R-L3-protocol-index.1. The tool is the single script `.ai/bin/protocol-index.cjs`: it derives a compact, addressable index of `.ai/DECISIONS.md` into `.ai/runtime/decisions-index.md`, one deterministic first-sentence norm per block and a reverse index from path to the decisions that name it (FACT .ai/bin/protocol-index.cjs:56-72, :85-106).
- R-L3-protocol-index.2. The source stays append-only and untouched; the index is derived, disposable, lives under `.ai/runtime/`, and is never a source of truth (FACT .ai/bin/protocol-index.cjs:7-8).
- R-L3-protocol-index.3. The output carries the sha256 of the file it was built from; a hash mismatch means the index is stale - discard it and read `.ai/DECISIONS.md`, never repair the index (FACT .ai/bin/protocol-index.cjs:8-10).
- R-L3-protocol-index.4. `--check` reports staleness without rewriting anything, so a certified read can verify its index before trusting it (FACT .ai/bin/protocol-index.cjs:130).
- R-L3-protocol-index.5. The index is advisory: never Evidence, never a gate input, never a verdict (PROTO-DEC-0044 item 4; PROTO-DEC-0034 item 1).
- R-L3-protocol-index.6. The script's only option is `--check`; every other flag is accepted and ignored, so an unknown option exits 0 instead of the standard's 2 (FACT .ai/bin/protocol-index.cjs:165) - an OPEN gap against the fail-closed rule of PROTO-DEC-0047 item 8, recorded here as the real behavior.
- R-L3-protocol-index.7. The derived rows are a pure function of the source - same source, same norms, same source hash - but the output file also stamps its build time (FACT .ai/bin/protocol-index.cjs:121), so two builds of an unchanged source differ in bytes; byte-identical rebuilds are not a property of this tool.

## Steps

1. **Build** (any agent). Run the script without `--check` after `.ai/DECISIONS.md` changes; the derived rows come out deterministically from the source, with the build-time stamp as the only byte difference between two runs on an unchanged source (R-L3-protocol-index.7). Input: `.ai/DECISIONS.md`; output: the derived index.
2. **Verify** (the reader of the moment). Run with `--check` before trusting the index; a mismatch discards it (R-L3-protocol-index.3). Input: the index and its source hash; output: the staleness verdict.
3. **Read** (reviewer). Use the index to find blocks; the norm a block carries is read in `.ai/DECISIONS.md` itself - the index points at blocks and never restates them (PROTO-DEC-0044 item 2). Input: the index; output: the decision ids to open.

## Stop conditions

- A hash mismatch during a certified read: stop using the index, rebuild or read the source; the index is never repaired by hand (R-L3-protocol-index.3).
- A decision block the index cannot parse: the source is authoritative - record a `signal:procedure-gap` and read the source directly.

## Back edges

None; the tool derives and reports, it decides nothing and loops nowhere.

## Evidence

Decision basis: PROTO-DEC-0044 items 2 and 5 and PROTO-DEC-0034 item 1.
The derived index is advisory; the approved decision remains the source of truth.
No historical log-size measurement or measured saving is supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A stale index is treated as truth | medium | medium | the source sha256 in the output; `--check` (R-L3-protocol-index.3-4) | one check run | a reader who skips the check |
| A hand-edited index | low | high | the index is disposable under `.ai/runtime/` and rebuildable | one rebuild | a local edit that survives until the next mismatch |
| The block format of the source drifts | low | medium | the index fails to parse rather than guessing; stop condition above | one signal | an index that silently drops blocks |

## Change log

- 0.1 — 2026-10-05
- 0.2 — 2026-10-14
