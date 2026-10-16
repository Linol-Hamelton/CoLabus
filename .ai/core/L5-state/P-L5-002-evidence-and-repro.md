---
id: P-L5-002
version: 0.4
title: Evidence and candidate evidence, reproduction locator - recorded, never asserted
layer: L5
type: procedure
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [all]
stages: [accept, freeze, close]
triggers: [session-end, gate-run, candidate-frozen]
inputs: [journal, findings-ledger]
outputs: [evidence, journal]
tools: [TOOL-protocol-ledger]
back_edges: []
enforcement: S
enforced_by: [.ai/bin/protocol-handoff.cjs, .ai/bin/protocol-handoff/candidate.cjs, .ai/bin/protocol-ledger.cjs]
script_candidate: yes
evidence_class: [A, B]
cost_basis: unknown
evidence: [AGENTS.md:327, PROTO-DEC-0042, PROTO-DEC-0044:4, .ai/core/RULE-MAP.md:68]
---

# P-L5-002 Evidence, candidate evidence and the reproduction locator

Draft of the unified-completion record set (PROTO-DEC-0185 item 2), written through the
P-L0-001 lifecycle; binding only by a later owner act. The home of the Evidence rules of
AGENTS.md section 7 (RULE-MAP rows AR-048, AR-050, AR-051 point their invariant parts to
SCHEMA-evidence, which lands in the same act); the tools already exist and are the
`enforced_by` of this record: nothing here rebuilds them.

## Purpose

The protocol used to transfer assertions: an agent wrote "the suite passes" and the next
agent could not check it (PROTO-DEC-0042: certifier receipts went stale after a controller
fix). Recorded Evidence, tied to a candidate digest computed from git objects, makes the
receipt independent of what later happens in the checkout, and the reproduction locator
makes a finding reproducible from the repository, not from a certifier's private worktree
(D S-deepseek-07).

## Rules

- R-L5-002.1. An Evidence block is written only by `protocol-handoff.cjs record --owner <session>`; a hand-written block is never Evidence, and prose in a journal is a claim, not a record (AGENTS.md:325-381). [not mechanically enforced]
- R-L5-002.2. Producer evidence may tie to a candidate: `record --candidate <full-sha>` records the candidate commit, baseline, tree, digest and scope, the digest computed from git objects in a detached worktree, so the receipt does not go stale when the main checkout moves; the dirty flag stays honest and the digest, not the flag, carries the link ( section 2). [not mechanically enforced]
- R-L5-002.3. `verify` recomputes the tree digest and the entry hash from the current tree; a tree that moved fails, it is never re-asserted (AGENTS.md:368-376). [not mechanically enforced]
- R-L5-002.4. After a legitimate redaction of an entry, and only then, `rehash --owner <session> --reason <text>` refreshes the entry hash; no other rewrite of a recorded entry is allowed (AGENTS.md:361-366). [not mechanically enforced]
- R-L5-002.5. A reproduction locator in a findings-ledger row takes exactly one of the closed forms `repo:`, `external:` or `none`; nothing is executed when it is parsed, an `external:` locator requires its sanction block, and `none` is allowed only for a recommendation and never proves a FAIL or BLOCKED claim ( section 3). [not mechanically enforced]
- R-L5-002.6. The shape of the Evidence block and of the locator line is SCHEMA-evidence; this record and that schema are one act of P-L0-001. [not mechanically enforced]
- R-L5-002.7. A secret never reaches a journal entry or an Evidence block; `record` and the Stop hook scan for it and block the handoff (AGENTS.md:358-359; the invariant home is R-L0-07). [not mechanically enforced]

## Steps

1. **Write the entry** (any role). The session journal entry with its five labels first; `record` refuses a journal without a dated entry. Input: the work. Output: the entry.
2. **Record** (any role). `node .ai/bin/protocol-handoff.cjs record --owner <session>`; it runs the validator, the configured test command and the protocol suite, and stamps the exit codes and the tree digest. Input: the entry. Output: the Evidence block.
3. **Bind a candidate** (producer). `record --candidate <40-hex> --baseline <40-hex>`; the candidate digest is computed in a detached worktree that is removed in `finally`. Input: the candidate commit. Output: candidate fields in the Evidence block.
4. **Verify** (the next reader). `node .ai/bin/protocol-handoff.cjs verify`; a moved tree or a rewritten entry fails with a named reason. Input: the journal. Output: the verify line in the reader's journal.
5. **Locate a reproduction** (reviewer). Write the locator into the findings-ledger row of the review, `repo:` for a script inside the candidate with its interpreter, argv, exit and sha256, `external:` for a sanctioned borrowing, `none` only for a recommendation. Input: the finding. Output: the locator row.

## Stop conditions

Stop and go to P-L0-002 when:
- `record` or `verify` fails and the reason is not understood;
- the candidate journal exceeds the line limit and archiving does not repair it;
- a reproduction needs a path outside the repository that no sanction block covers.

## Back edges

None.

## Evidence

- A - the receipt pattern replaced assertions across the fleet; AGENTS.md section 7 makes it the only way to hand off (AGENTS.md:325-381).
- B - stale certifier receipts (PROTO-DEC-0042) and repro scripts living only in certifier worktrees ( section 1, D S-deepseek-07) are the two measured failures this record closes; the digest fix is  section 2. Cost: unknown.
- A - RULE-MAP rows AR-048, AR-050 and AR-051 (`.ai/core/RULE-MAP.md:68-71`) name SCHEMA-evidence as the invariant home; the procedure rules live here.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| An Evidence block is written by hand | low | high | R-L5-002.1; `verify` recomputes the entry hash | none | an unread block taken on trust |
| A `none` locator is read as proof | medium | high | R-L5-002.5; the verdict reader treats it as non-proving | none | a reader who skips the rule |
| Candidate checks slow the record | medium | medium | the suite runs in the source role only; `PROTOCOL_NO_FULL_SUITE` skips it when the owner sets it | runtime | a skipped suite is named in the block scope |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-16
