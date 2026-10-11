---
id: TOOL-protocol-core
version: 0.3
title: Kernel record tooling - lint, artifact-lint, catalog, check-links, packet, lcc, verify, root-size
layer: L3
type: tool
status: draft
roles: [all]
stages: [any]
triggers: [record-change, gate-run, owner-directive]
inputs: [CATALOG, .ai/core/RULE-MAP.md, .ai/core/EXTERNAL-PENDING.md, .ai/core/schema/procedure.schema.md, .ai/DECISIONS.md]
outputs: [CATALOG]
back_edges: []
enforcement: S
enforced_by: [.ai/bin/protocol-core.cjs]
script_candidate: yes
evidence_class: [A]
evidence: [PROTO-DEC-0061, PROTO-DEC-0047:8, PROTO-DEC-0049, .ai/bin/protocol-core.cjs:3, .ai/bin/protocol-core.cjs:670, .ai/bin/protocol-core.cjs:8, .ai/bin/protocol-core.cjs:10, .ai/bin/protocol-core.cjs:11, .ai/bin/protocol-core.cjs:17, .ai/bin/protocol-core.cjs:18, .ai/core/CATALOG.md:3]
---

# TOOL-protocol-core Kernel record tooling

This draft record describes the tooling contract. Activation is a separate owner act. The rules checked by the tool remain in SCHEMA-procedure and P-L0-004.

## Purpose

One deterministic script answers "is this corpus a valid kernel" - record shape, catalog freshness,
reference resolution, packet budget, layer consistency, root size - so that no record lands on a
prose assertion alone and no kernel gate depends on a model, the network or git history.

## Rules

- R-L3-protocol-core.1. The tool is the single script `.ai/bin/protocol-core.cjs` with the commands lint, artifact-lint, catalog, check-links, packet, lcc, verify and root-size (FACT .ai/bin/protocol-core.cjs:3; artifact-lint: FACT .ai/bin/protocol-core.cjs:670).
- R-L3-protocol-core.2. Its inputs are repository files and the headings of `.ai/DECISIONS.md` only - no network, no model, no git history - and the same tree gives the same output (FACT .ai/bin/protocol-core.cjs:10).
- R-L3-protocol-core.3. It fails closed: unknown input exits 2 and is never guessed, exit 1 is a broken rule, exit 0 a pass (FACT .ai/bin/protocol-core.cjs:11; PROTO-DEC-0047 item 8).
- R-L3-protocol-core.4. Every enumeration and registry it enforces is read from the canon's dictionaries block (procedure.schema.md section 6); the code keeps no literal copy, so a schema change is a re-verification of the tool (FACT .ai/bin/protocol-core.cjs:8-9).
- R-L3-protocol-core.5. It enforces PROTO-DEC-0061 (stage 1: procedure.schema.md, P-L0-004), the script standard of PROTO-DEC-0047 item 8 and the front-matter grammar of PROTO-DEC-0049 item 2 (FACT .ai/bin/protocol-core.cjs:17), and carries the packet budget of 100000 B (FACT .ai/bin/protocol-core.cjs:18) and the root-size budgets (FACT .ai/bin/protocol-core.cjs:19-24).
- R-L3-protocol-core.6. CATALOG.md is derived by its `catalog` command and never edited by hand, and `catalog --check` fails when the file is stale (FACT .ai/core/CATALOG.md:3).
- R-L3-protocol-core.7. A gate result belongs to the exact tree it ran on: the candidate records the full argv, UTC, tree SHA and the real exit code, and any edit after the run re-opens the affected gates - a prior PASS does not transfer (FACT ).

## Steps

1. **Lint** (author, after any record change). `node .ai/bin/protocol-core.cjs lint .ai/core` - exit 0 required before anything else. Input: the changed records; output: the lint exit code in the journal line.
2. **Catalog** (author). `node .ai/bin/protocol-core.cjs catalog`, then `catalog --root .ai/core --check`; the derived CATALOG.md is committed with the change. Input: the record corpus; output: CATALOG and the check exit code.
3. **Resolve** (reviewer). `check-links` in the mode the gate needs (design, layer or strict package); every dangling or stale row is fixed or registered, never argued away. Input: the corpus and the EXTERNAL-PENDING registry; output: the resolution rows.
4. **Gate** (coordinator). `verify --layer <N>` (or `verify --package <id>` at a freeze) on the exact candidate; record argv, UTC, tree SHA and the real exit code in the gate report. Input: the whole corpus; output: the VERIFY/RESULT rows.

## Stop conditions

- Exit 2 (unknown input): fix the input or the record; never work around the parser, and a repeated unknown form goes to P-L0-002.
- A missing dictionaries block, a missing RULE-MAP or a wrong map header: the corpus is wrong, not the tool - stop and repair the corpus (fail-closed, R-L3-protocol-core.3).
- The tree changed after a gate run: re-run the affected gates before quoting any result (R-L3-protocol-core.7).

## Back edges

None; the tool is a gate, not a loop. A failed gate returns the corpus to the author of the record change through P-L0-001's own back edges.

## Evidence

Decision basis: PROTO-DEC-0061 and the script standard of PROTO-DEC-0047
item 8. Run the tool against the actual corpus and retain its exit codes.
This document is not proof of a successful gate or certification.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The tool drifts from the schema it enforces | low | high | dictionaries read from the canon (R-L3-protocol-core.4); re-verification on input-format change (PROTO-DEC-0047 item 8) | one test run | a schema change without the re-verification |
| A gate quoted for a tree it did not run on | medium | high | tree SHA in the verify output; R-L3-protocol-core.7 | one re-run | a stale PASS in prose |
| A stale CATALOG after a record change | medium | low | `catalog --check` inside every verify run | one regeneration | a hand-edited CATALOG |
| The gate is run in the wrong mode | medium | medium | the mode is printed in the VERIFY row; the final gate is never chosen implicitly | one re-run | a design-mode pass read as a freeze pass |

## Change log

- 0.3 — 2026-10-08
- 0.2 — 2026-10-05
- 0.1 — 2026-10-05
