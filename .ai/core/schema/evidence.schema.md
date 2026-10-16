---
id: SCHEMA-evidence
version: 0.3
title: Shape of the Evidence block, candidate evidence fields and the reproduction locator
layer: L5
type: schema
status: draft
roles: [all]
stages: [accept, freeze, close]
triggers: [session-end, gate-run, candidate-frozen]
inputs: [journal, findings-ledger]
outputs: [evidence]
back_edges: []
enforcement: S~
enforced_by: [.ai/bin/protocol-handoff.cjs, .ai/bin/protocol-handoff/candidate.cjs, .ai/bin/protocol-ledger.cjs]
script_candidate: yes
evidence_class: [A, B]
cost_basis: unknown
evidence: [AGENTS.md:327, PROTO-DEC-0042, .ai/core/RULE-MAP.md:68]
---

# Evidence schema

Draft of the unified-completion record set (PROTO-DEC-0185 item 2), written through the
P-L0-001 lifecycle; binding only by a later owner act. The invariant home of RULE-MAP rows
AR-048, AR-050 and AR-051; the procedure rules live in P-L5-002, which lands in the same
act. The shape below is what `protocol-handoff.cjs` actually writes (its `renderEvidence`
and the candidate binding) - quoted, not redesigned; the writer is the single source, and
this schema is its readable form.

## Purpose

An Evidence block is the difference between a claim and a record. Its shape is fixed so
that `verify`, the gate and any later reader parse the same fields with a closed grammar,
never by guessing, and so that a rewritten entry is detectable from the entry hash alone.

## Rules

- R-L5-evidence.1. An Evidence block is produced only by `protocol-handoff.cjs record`; a block missing a required field does not verify. Enforcement of the closed field set is partial today: the candidate reader validates the candidate fields one by one (a missing, duplicated or malformed candidate field is refused), while the general reader of a recorded block reads the named fields and does not reject an unknown extra line; strict unknown-field rejection by the readers is a pending obligation of this schema, not a behaviour any tool has today. [not mechanically enforced]
- R-L5-evidence.2. The entry hash covers the entry without the block; any rewrite of a recorded entry breaks the chain and is refused by `record`, and a legitimate redaction refreshes the hash only through `rehash --owner <session> --reason <text>`. [not mechanically enforced]
- R-L5-evidence.3. Candidate fields bind a receipt to a full 40-hex commit and its digest computed from git objects, so the receipt survives later writes in the checkout. [not mechanically enforced]
- R-L5-evidence.4. A reproduction locator takes exactly one of the three closed forms below; `none` never proves a FAIL or BLOCKED claim. [not mechanically enforced]

## Block

Written by `record` inside the session's newest dated entry, after the entry body:

```
Evidence:
- anchor: <40-hex commit>, <clean tree or uncommitted changes present>
- digest: sha256:<64 hex> over <n> tracked and untracked files
- digest format: <n>
- recorded: <ISO 8601> by <session>
- entry hash format: <n>
- entry: sha256:<64 hex> of this entry without this block
- parent-entry: <parent entry hash, or root>
- scope: <what ran: validator, suite, host tests; what did not>
- <check name>: exit <code> in <duration>
- reproduce: node .ai/bin/protocol-handoff.cjs verify
```

With `--candidate <sha> --baseline <sha>`, the same block carries, before `recorded`:

```
- candidate: <40-hex commit>
- candidate-baseline: <40-hex commit>
- candidate-tree: <40-hex tree>
- candidate-digest: sha256:<64 hex>
- candidate-scope: <scope of the recorded checks>
- candidate-checks: <n>
```

## Reproduction locator

One line of a findings-ledger row, fixed grammar, nothing executed at parse time
( section 3):

```
repro ::= "repo:" path "; interp:" ("node"|"pwsh"|"bash") "; argv:" json_array "; exit:" int "; sha256:" hex64
        | "external:" location "; sha256:" hex64 "; sanction:" decision_id
        | "none"
```

- `repo:` names a relative path without `..`, absolute forms or UNC, an ordinary file inside
  the candidate whose sha256 must match; otherwise the row is malformed (exit 2).
- `external:` requires a sanction block naming the borrowing decision.
- `none` is allowed only for a recommendation; it never proves a FAIL or BLOCKED claim.

## Reading

`verify` recomputes the tree digest from the current tree and the entry hash from the entry
without the block; either mismatch fails with a named reason. A block whose fields parse but
whose checks did not run is a scope question, not a pass: the scope line names what did not
run, and a missing check is never read as a pass. An unknown extra line in a block is skipped
by the general reader today (R-L5-evidence.1 names the partial enforcement and the pending
obligation); the candidate fields themselves are validated one by one.

## Evidence

- A - the block shape is the output of the landed writer, quoted field for field (AGENTS.md:325-381).
- B - the candidate fields exist because receipts went stale after closing fixes (PROTO-DEC-0042;  section 2). Cost: unknown.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The schema drifts from the writer | low | high | the writer is the single source; this record quotes it | none | a change to the writer without a version bump here |
| A hand-written block passes a casual read | medium | high | R-L5-evidence.1; `verify` recomputes the hashes | none | a reader who does not verify |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
