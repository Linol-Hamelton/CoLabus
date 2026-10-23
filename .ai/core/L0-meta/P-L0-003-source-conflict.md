---
id: P-L0-003
version: 0.3
title: Resolve a conflict between two sources of truth
layer: L0
type: procedure
status: active
owner_approval: PROTO-DEC-0061
decision: [PROTO-DEC-0061]
roles: [all]
stages: [any]
triggers: [source-conflict]
inputs: [decisions-index, journal, CATALOG]
outputs: [journal, signals, stop-question]
back_edges: []
enforcement: P
script_candidate: no:4
evidence_class: [A, B]
evidence: [AGENTS.md:28]
cost_basis: unknown
---

# P-L0-003 Resolve a conflict between two sources of truth

The record metadata declares its status, applicability and approval basis.

## Purpose

When sources disagree, the root ranking (R-L0-03) settles precedence. This procedure
says what to do with the lower-ranked text and what to do when the ranking does not
settle the conflict, so an agent does not act on a stale restatement.

## Rules

- R-L0-03.1. Name both sources with `path:line` before deciding anything.
- R-L0-03.2. The higher-ranked source wins; the lower one is stale and is never acted on.
- R-L0-03.3. A stale text is fixed by the session that owns it and has it in scope; otherwise it
  is reported, never silently left.
- R-L0-03.4. Two accepted decision blocks that conflict without a `Supersedes:` line are not
  resolved by any agent; the case goes to the owner.

## Steps

1. **Locate** (any role). Write both sources as `path:line` and quote nothing longer than
   needed. Output: a journal line `Conflict: <path:line> vs <path:line>`.
2. **Rank** (any role). Apply R-L0-03: decisions > tree and git > task > plan > journals >
   archive. Use the reverse map of `decisions-index` to find every block that names the path.
3. **Same rank?** If both are accepted decision blocks, check for `Supersedes:`; if one
   supersedes the other, the later wins. If neither does, go to P-L0-002 with problem
   `sources conflict` and trigger `higher-source-contradiction` in mind for P-L0-005.
4. **Handle the loser** (any role). If the stale text is in a file the session owns and in
   scope, fix it in the same candidate and say so in the journal. If not, record a
   `procedure-gap` signal naming the stale path, and for a shared document add a line to the
   task's open questions under the lock.
5. **Continue** on the winning source.

## Stop conditions

- Step 3 finds two unsuperseded conflicting decisions.
- The winning source itself is ambiguous at the point of conflict.
- Fixing the stale text would leave the task's scope.

## Back edges

None. A stop goes to P-L0-002 and the answer re-enters at step 5.

## Evidence

The source ranking is defined by AGENTS.md and R-L0-03. Stale restatements can
contradict an approved decision; the procedure requires resolving or reporting that
conflict. No incident count or measured saving is claimed here.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| An agent "fixes" a higher source to match a lower one | low | high | R-L0-03.2; decision blocks are immutable and validator-checked | none | wording outside decisions |
| Reports pile up unfixed | medium | medium | signals are grouped at batch planning (0051 item 2) | coordinator time | — |
| Same-rank conflicts flood the owner | low | medium | step 3 checks `Supersedes:` first | one grep | — |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-09-27
