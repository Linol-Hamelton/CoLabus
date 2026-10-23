---
id: P-L0-006
version: 0.4
title: Find candidates to improve or retire a kernel record
layer: L0
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0061, PROTO-DEC-0158, PROTO-DEC-0160]
roles: [coordinator, reviewer]
stages: [any]
triggers: [signal:procedure-gap, signal:fall, review-finding, stop-question, trial-kill, source-conflict, owner-directive]
inputs: [signals, findings-ledger, journal, CATALOG, decisions-index]
outputs: [journal, signals]
back_edges: []
enforcement: P
script_candidate: no:4
evidence_class: [C]
evidence: [PROTO-DEC-0060, PROTO-DEC-0050, PROTO-DEC-0051]
---

# P-L0-006 Find candidates to improve or retire a record

The record metadata declares its status, applicability and approval basis.

## Purpose

A kernel record should change when there is a reason, and only then. Disuse is not a reason:
in a layered kernel a record is loaded when its role, stage or trigger comes up, so long gaps
are expected (PROTO-DEC-0060). This procedure says which findings make a record a candidate,
whether the candidate is for improvement or for retirement, and where each goes next.

## Rules

- R-L0-20.1. A record becomes a candidate only through a finding listed in step 2; how often it
  was used is never a finding.
- R-L0-20.2. An improvement candidate goes to P-L0-001 as a change (class D); a retirement
  candidate goes to the comparative test of P-L0-007 first.
- R-L0-20.3. A candidate names its finding with a signal id, a ledger row or a `path:line`.
- R-L0-20.4. The coordinator proposes; the owner decides every retirement.

## Steps

1. **Collect** (coordinator). At batch planning, gather the open signals (PROTO-DEC-0051 item 2),
   the findings of the batch's reviews, the stop-questions asked, and any trial whose kill
   criterion was reached.
2. **Match** (coordinator). A record is a candidate when one of these holds:

| Finding | Kind | Source |
|---|---|---|
| its trigger fired and it was not applied, or was applied and did not prevent the failure it exists for | improve | signal `fall` or `procedure-gap` naming it |
| the same workaround around it was used a second time | improve | PROTO-DEC-0051 item 2 |
| a stop-question was asked about it, or the owner needed more than one clarification | improve | stop-question, M-002 |
| a reviewer found a defect whose root cause is its wording | improve | findings ledger |
| its trial reached the kill criterion | improve or retire | its `trial` field |
| another record now carries the same rule (two homes) | retire the copy | LCC-1 of P-L0-004 |
| its subject no longer exists (a tool removed, a decision superseded) | retire | decisions-index, CATALOG |
| it causes cost or defects that its gain does not cover | retire | ledger, M-007 |

3. **Record** (coordinator). One line per candidate in the journal:
   `Candidate: <record id> | improve|retire | finding=<id or path:line> | proposed=<change>`,
   and a signal of type `procedure-gap` with `rc=` naming the record.
4. **Route** (coordinator). Improvement candidates go to P-L0-001 step 1 as a change. Retirement
   candidates go to P-L0-007 with the record as the variant under test.
5. **Review** (reviewer). The reviewer checks that each candidate's finding is real and that no
   candidate rests on disuse alone.

## Stop conditions

- A finding points at a decision block, not at a record: that is P-L0-005, not this procedure.
- The finding cannot be reproduced: it stays a note and does not make a candidate.

## Back edges

None. The candidate re-enters the kernel through P-L0-001 or P-L0-007.

## Evidence

Decision basis: PROTO-DEC-0060 item 2. Disuse does not justify retirement.
Failure classes and repeated workarounds are governed by PROTO-DEC-0050 and
PROTO-DEC-0051. Trial: M-008, counted by hand until L6 defines it.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The kernel keeps growing because nothing is retired | medium | medium | the two-homes and obsolete-subject findings; the A/B/C test at program end | one pass per batch | the owner keeps a record alive |
| A useful record is proposed for retirement | low | high | P-L0-007 test before retirement; owner decides | one test | small samples |
| Candidates pile up unhandled | medium | medium | grouping at batch planning; groups open two batches go to the owner (0051 item 2) | coordinator time | — |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-27
- 0.3 — 2026-10-01
- 0.4 — 2026-10-04
