---
id: TOOL-protocol-ledger
version: 0.2
title: Coverage ledger and duplicate detection over a corpus - advisory
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0184
decision: [PROTO-DEC-0184]
roles: [all]
stages: [any]
triggers: [corpus-cover, corpus-dup, owner-directive]
inputs: [review-report]
outputs: [.ai/runtime/coverage-ledger.md, .ai/runtime/duplicate-report.md]
back_edges: []
enforcement: S
enforced_by: [.ai/bin/protocol-ledger.cjs]
script_candidate: yes
evidence_class: [A]
evidence: [.ai/core/RULE-MAP.md:62, PROTO-DEC-0044, PROTO-DEC-0034, .ai/bin/protocol-ledger.cjs:3, .ai/bin/protocol-ledger.cjs:18, .ai/bin/protocol-ledger.cjs:240]
---

# TOOL-protocol-ledger Coverage ledger and duplicate detection

This draft record describes coverage and duplicate detection over a corpus. Outputs remain advisory; activation is a separate owner act.

## Purpose

The tool checks whether records cover every unit of the declared corpus and
reports duplicated producer content. Source lists inherited from a prompt can
omit primary material; comparison can reveal copied submissions. Outputs remain
advisory and never become a gate.

## Rules

- R-L3-protocol-ledger.1. The tool is the single script `.ai/bin/protocol-ledger.cjs` with two commands: `cover --records <dir>` accounts for every unit of a corpus with one record or an explicit absence, arithmetic closed, and `dup <dir> <dir>` reports records shared between producers by content hash (FACT .ai/bin/protocol-ledger.cjs:3, :10-11, :15-16).
- R-L3-protocol-ledger.2. Both commands take the corpus from the repository and not from the prompt, and both work where the corpus is not a git repository (PROTO-DEC-0044 item 3).
- R-L3-protocol-ledger.3. The outputs are derived and advisory: never Evidence, never a gate input, never a verdict - the tool reports, it does not decide (FACT .ai/bin/protocol-ledger.cjs:18; PROTO-DEC-0044 item 4; PROTO-DEC-0034 item 1). `cover` defaults its ledger to `.ai/runtime/coverage-ledger.md` and `dup` to `.ai/runtime/duplicate-report.md` of the run root (FACT .ai/bin/protocol-ledger.cjs:257, :292).
- R-L3-protocol-ledger.4. A unit without a record is a question, not a defect, because it may be a declared classification; a record with no unit behind it is always a defect (PROTO-DEC-0044 item 4).
- R-L3-protocol-ledger.5. A directory that is not there must not read as a directory that is empty: an empty result from a missing path is a false all-clear, worse than no answer (FACT .ai/bin/protocol-ledger.cjs:240).
- R-L3-protocol-ledger.6. Confining every report to `.ai/runtime/` is the norm of PROTO-DEC-0044 item 4, but the CLI does not enforce it: both commands accept `--out <file>` and write wherever it points (FACT .ai/bin/protocol-ledger.cjs:257, :292) - an OPEN gap, recorded here instead of described as an implemented contract.
- R-L3-protocol-ledger.7. The fail-closed rule of the script standard (unknown input exits 2, PROTO-DEC-0047 item 8) is met for the command word and the required directories, not for options: `dup` skips any unrecognized option and exits 0 (FACT .ai/bin/protocol-ledger.cjs:277), and `cover` ignores options it does not read - an OPEN gap against the standard.

## Steps

1. **Cover** (reviewer or coordinator). Declare the corpus from the repository, run `cover --records <dir>`, and read the arithmetic: every unit has a row or an explicit absence. Input: the records directory and the corpus; output: the coverage ledger (default `.ai/runtime/`; `--out` moves it anywhere, R-L3-protocol-ledger.6).
2. **Read the gaps** (the same reader). A unit without a record is a question to its producer; a record with no unit is a defect to fix. The ledger result is advisory and blocks nothing by itself (R-L3-protocol-ledger.3-4). Output: the questions and defects in the journal or review report.
3. **Dup** (reviewer). Run `dup` over the producer directories of one contract; shared rows go to the independence judgement of the review, not to an automatic verdict (PROTO-DEC-0044 item 3). Input: the record sets; output: the shared-rows report.

## Stop conditions

- A declared corpus directory does not exist: the tool refuses it (R-L3-protocol-ledger.5); do not create a directory to make a run pass - stop and re-declare the corpus from the repository.
- The ledger result would enter a verdict or a completion gate: stop - it is advisory (R-L3-protocol-ledger.3; FACT .ai/core/RULE-MAP.md:62).

## Back edges

None; the tool reports, it does not loop.

## Evidence

Decision basis: PROTO-DEC-0044 items 3 and 5; mapping home AR-042.
Coverage and duplication outputs are advisory, not Evidence or acceptance gates.
No historical omission count, copied submission or measured saving is supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The ledger is treated as a gate | medium | high | R-L3-protocol-ledger.3; AR-042 "advisory only" (FACT .ai/core/RULE-MAP.md:62) | none | a verdict that cites coverage rows as proof |
| The corpus is declared from the prompt | medium | high | R-L3-protocol-ledger.2 takes the corpus from the repository | one re-run | an inherited scope that matches the prompt, not the repo |
| A missing directory reads as empty coverage | low | high | R-L3-protocol-ledger.5 refuses the path | one corrected run | an exclusion list that hides the missing path |
| A gap is read as a defect, or a defect as a gap | medium | medium | R-L3-protocol-ledger.4 fixes the reading | reviewer attention | a declared classification mistaken for an omission |

## Change log

- 0.1 — 2026-10-05
- 0.2 — 2026-10-14
