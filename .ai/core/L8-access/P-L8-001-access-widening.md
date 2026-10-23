---
id: P-L8-001
version: 0.4
title: Access widening - recorded reading beyond the declared set, delegated rights, outside changes
layer: L8
type: procedure
status: active
owner_approval: PROTO-DEC-0183
decision: [PROTO-DEC-0183]
roles: [all]
stages: [any]
triggers: [scope-exceeded, owner-directive, stage-enter:accept]
inputs: [task-frame, journal, .ai/core/schema/delegation.schema.md, .ai/DECISIONS.md]
outputs: [journal, review-report]
back_edges: [4>5/1/owner]
enforcement: P
script_candidate: yes
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0049:1, PROTO-DEC-0048:8, PROTO-DEC-0062:3]
---

# P-L8-001 Access widening

Draft 0.1. Advisory until the owner
approves it (R-L0-17.6, R-L0-17.7); the compiler never includes a draft record. Built on the L8
preparation documents and on what the kernel already says:
reading is R-L0-09, the owner's authority is R-L0-04 and R-L1-owner.2, the stop on a scope edge is
R-L0-10.8 and R-L0-38.1. This record adds only the recording of widened reading, the delegation of
rights and the protocol of changes outside the repository; each rule names below what executes it.

## Purpose

An agent that needs to read or do more than its frame names either walks around the problem or
widens its own rights silently. The L8 preparation found nine access incidents in 2026-10-01..09
and thirteen rights granted only as free text with no expiry, no scope or no reader.
This record makes widened reading cost nothing but a
line, makes every right beyond the frame a record that a script can refuse when it is expired or
out of scope, and keeps changes outside the repository single-handed, backed up and recorded twice.

## Rules

- R-L8-001.1. Reading follows R-L0-09; its only limit is independence, so a sealed certifier reads no other certifier's report on the same candidate before fixing its own verdict (R-L1-certifier.2), and no widening line lifts that limit.
- R-L8-001.2. The declared read set is the frame's `sources` plus the records the packet names for the role and stage, and for a change that touches the protected set (R-L9-001.5) it is the whole tracked tree.
- R-L8-001.3. Reading outside the declared set needs no approval and is recorded by one line `Read-widening: <paths> reason=<text>` in the journal entry or report header that relies on it.
- R-L8-001.4. A certifier that relies on unchanged code outside the diff records that reading by such a line whose reason names the changed code that depends on it (PROTO-DEC-0049 item 1, R-L2-004.2).
- R-L8-001.5. The right to change belongs to the owner: edits inside the frame's `scope` are made under the frame its issuer wrote, and any other action that needs the owner's authority needs a delegation record of SCHEMA-delegation that holds at the instant of the action.
- R-L8-001.6. A delegation names who, which scope and until when, cites the owner's decision block and may only narrow the grant that block states, never carries the right to approve or to delegate further (R-L1-owner.2), and is refused when it is expired, not yet valid, outside its scope paths or the grant's, on a path excluded by it or by the grant, through a link, or for a verb it or the grant does not list.
- R-L8-001.7. A change outside the repository is made by one agent only, after a backup, and is recorded both in that agent's session journal and in a record in the folder where the change was made (PROTO-DEC-0048 item 8).

## Steps

Actor slots are defined in L1; "any" is any role that reads or acts.

1. **Declare** (coordinator, as frame issuer). Write the frame's `sources` and `scope`; they are the declared read set and the edit right. Input: task-frame. Output: task-frame.
2. **Widen reading** (any). When you read outside the declared set and rely on it, write the `Read-widening:` line of R-L8-001.3 in the entry or header that relies on it; a certifier writes the reason of R-L8-001.4. Input: the extra paths. Output: journal or review-report.
3. **Recognise a right beyond the frame** (any). An action outside the frame's `scope`, onto a `forbidden` path, or a commit, tag, merge, push, delete or move that the task does not name, is not taken on the frame (R-L0-38.1). Input: the next action. Output: the action named with grantee, scope-id, verb and paths.
4. **Check the delegation** (any). Run `node .ai/bin/protocol-delegation.cjs check <records> --grantee <you> --scope-id <scope> --verb <verb> --path <p>... --at <now, UTC>`. Exit 0: take the action and copy the `DECISION` rows into the journal entry. Exit 1: stop (P-L0-002) and ask the owner (back edge 4>5). Exit 2: the record file is malformed; stop and report it. Input: delegation records. Output: journal.
5. **Grant** (owner; transcribed by the lock holder). The owner records the delegation in an approved decision block whose metadata paragraph states the grant as live `Grant-*` lines (SCHEMA-delegation, "Basis"), and the record, no wider than the grant, is written to its home (SCHEMA-delegation, "Home of the records"); `protocol-delegation.cjs lint` exits 0 on the file. Input: the stop-question. Output: decision block and delegation record.
6. **Change outside the repository** (one agent). Claim the target, make a backup, make the change, then write the journal line and the record in the folder of the change (R-L8-001.7). Input: a delegation that holds. Output: journal and the local record.

## Stop conditions

Stop and go to P-L0-002 when:
- the check of step 4 exits 1 or 2;
- a widened read would break the independence limit of R-L8-001.1;
- a second agent already holds a claim on the same outside target, or no backup can be made;
- a right is asked of anyone other than the owner, or a delegation would let its grantee approve or delegate.

## Back edges

- `4>5/1/owner`: a refused check goes once to the owner for a grant; a second refusal of the same action is a stop, never another try.

## Execution map

What runs each rule today (as measured when this record was written). TEXT-ONLY
means no tool executes the rule; each such row names the candidate gate it waits for, and this
record adds no enforcement.

| Rule | Executed by | State and gap |
|---|---|---|
| R-L8-001.1 | `.ai/core/L1-roles/ROLE-certifier.md:48` (the `Prior-reports-read:` header the certifier declares) | TEXT-ONLY: no tool compares the declaration with what was read; candidate read-widening check |
| R-L8-001.2 | none | TEXT-ONLY: no tool computes the declared set; frames carry `sources` but no reader exists |
| R-L8-001.3 | none | TEXT-ONLY: before this record the line occurred once in the tree; candidate read-widening check |
| R-L8-001.4 | none | TEXT-ONLY; `.ai/core/L1-roles/ROLE-reviewer.md:51` carries the duty for reviewers only; candidate read-widening check |
| R-L8-001.5 | `.ai/bin/protocol-delegation.cjs` (`check`), by hand; `.ai/bin/protocol-scope.cjs:44-207` for the frame scope, by hand | partial: nothing calls either tool (no hook, validator or gate); wiring is a Class A act with an owner word |
| R-L8-001.6 | `.ai/bin/protocol-delegation.cjs` (`lint`, `check`) and its tests | executed when run: expiry, not yet valid, scope, exclusion, verb, grantee, scope-id, basis block read from its live statements only, containment in the owner's `Grant-*` lines, real paths of both sides (one real path per comparison), links refused, an excluded path excludes itself and everything below it in every spelling, a file-system error on a path is UNKNOWN and refuses (never a missing component, never a pass), the approver is a name of the closed owner list in the project data (`.ai/docs/owners.json`); not executed: who wrote the record (only the basis is checked) and revocation other than a later live `Supersedes:` line |
| R-L8-001.7 | none | TEXT-ONLY: no tool sees writes outside the repository (`.ai/core/L3-procedures/P-L3-004-route-failover.md:243`); candidate outside-change check |

## Evidence

- B - nine access incidents 2026-10-01..09: three would have been caught earlier by these records, none interrupted. Cost: unknown in attempts.
- B - nineteen contradictions found by the L8 audit, among them that the plan calls delegation an L5 artifact while the only grammar is the L1 role line, and that `Read-widening` exists only in the plan.
- C - the owner's design and decisions PROTO-DEC-0049 item 1, PROTO-DEC-0048 item 8, PROTO-DEC-0062 item 3. Trial: none defined yet; a class C record needs one before it can be active (R-L0-17.5).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A delegation file written by a non-owner | medium | high | the basis must be an accepted, approved decision block whose live `Grant-*` lines bound the record (R-L5-delegation.3, R-L5-delegation.7), and the approver must be a name of the closed owner list in the project data (`.ai/docs/owners.json`) | one lookup | a forged decision block, caught only by the decision-log immutability checks; a name forged INTO the owner list (the list is data the owner edits; the checker never writes it) |
| Rules stay text because nothing calls the checker | high | medium | the execution map names each gap and its candidate | none | as today until the owner wires a gate |
| A path trick (case, link, junction, hard link, trailing dot) escapes an exclusion | medium | high | the checker resolves requested, scope and excluded paths by the same real-path rule, refuses any link in a requested path or its ancestors, and keeps a positive path grammar (R-L5-delegation.6) | none | a file system the tests do not cover; a swap after the check (the checker writes nothing) |
| The widening line becomes ceremony | medium | low | it costs one line and needs no approval | one line | lines nobody reads |

## Change log

- 0.1 — 2026-10-10
- 0.2 — 2026-10-10
- 0.3 — 2026-10-11
- 0.4 — 2026-10-14
