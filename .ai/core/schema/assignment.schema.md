---
id: SCHEMA-assignment
version: 0.6
title: Grammar of role assignments and delegations in a task frame
layer: L1
type: schema
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0165]
evidence_class: [B, D]
evidence: [PROTO-DEC-0048, PROTO-DEC-0049, PROTO-DEC-0056, PROTO-DEC-0057, PROTO-DEC-0062, PROTO-DEC-0063, AGENTS.md:69]
cost_basis: unknown
---

# Role-assignment grammar

The independence check reads the role-assignment grammar below. A line outside the grammar is unknown input and exits 2.

## 1. Participant (S2-T05)

Who counts as one participant is R-L1-002.1 and the lineage is R-L1-002.2; both have their home in
P-L1-002. This schema only applies them: every `model` in a line is resolved to the maker's id in
the model matrix () before any check; the matrix records,
for example, that copilot reaches `claude-opus-5-5` as `claude-opus-5`. This replaces the
family-and-lineage identity proposed in  section 2 (PROTO-DEC-0056 item 2, 0063 item 2).

## 2. Grammar

```
roles_section ::= "## Roles" LF { line LF }
line          ::= assignment | delegation | blank
assignment    ::= "- " model " @ " scope_id ": " slot
delegation    ::= "- delegation @ " scope_id ": " model " until " date " by " block_id
model         ::= a model id present in the model matrix
scope_id      ::= kind ":" name
kind          ::= "program" | "task" | "candidate"
name          ::= a-z0-9{2,63}         for "candidate", the 40-hex SHA
slot          ::= coordinator | implementer | reviewer | certifier | shadow-certifier
                | auditor | researcher | synthesiser | drafter | critic | fixer | procedure-author
date          ::= YYYY-MM-DD
block_id      ::= "PROTO-DEC-" 4 digits | "DEC-" 4 digits
```

- One slot per line, no trailing text, no negation, no comment.
- `owner` is not a slot of an assignment line: the owner is the human who writes the lines or
  delegates them (R-L0-04, R-L1-owner.2). A line that names `owner` as its slot exits 2.
- A task frame names its parent with `parent-scope: <scope_id>`, or `-` for none. Lines of the
  parent scope are inherited defaults: a model that the frame's own lines do not name holds its
  parent-scope role in the frame; a model that the frame's own lines name holds only those lines.
  The one-role rule (R-L2-002.2) is checked on these effective lines of one frame (PROTO-DEC-0057
  item 3). Independence across frames is judged by the lineage (R-L1-002.2) and the bars of
  R-L0-05, R-L1-certifier.1 and R-L1-fixer.2, never by the merge.
- `dispatcher` is not a slot of an assignment line either (R-L1-dispatcher.1).
- Conditions that are not roles (dates, pilots, priorities, history) go under `## Role notes`,
  which no script reads.

## 3. Reading rules

Inputs, all repository-relative, each read with rules 1-3:
- the role document: the one file whose `## Roles` section holds the assignment and delegation
  lines of every scope (today `.ai/TASK.md`). Each line carries its own scope-id, so the lines of a
  scope are the lines that name it;
- the scope registry (artifact `scope-registry`; its path is fixed with the task-frame schema in
  S3-T03): one line per issued scope, `- <scope_id> frame=<path> parent=<scope_id or ->`, written by
  whoever issues the scope-id, the owner or the coordinator ( section 4).

1. Fenced blocks are removed first, by CommonMark rules: a fence closes only on the same character
   (backtick or tilde) repeated at least as many times as it opened; an unclosed fence runs to the
   end of the file.
2. Outside fences, exactly one heading `## Roles` must exist. Any other heading that begins with
   `## Roles` (for example `## Roles archive`) exits 2, so no decoy section can shadow the real one.
3. The section ends at the next `## ` heading. Each line in it must match the grammar.
4. Effective lines: the frame's own lines, plus each parent-scope line whose model the frame's own
   lines do not name (section 2). The parent scope's own lines are checked as a frame of their own.
5. Scope resolution. The frame's scope-id has exactly one registry line; its `frame=` file exists
   and holds exactly one `scope-id:` and one `parent-scope:` field, equal to the registry line's
   scope-id and `parent=`. Anything else exits 2.
6. Parent resolution. `parent=-` means no parent. Otherwise the parent has its own registry line,
   differs from the scope itself, and has `parent=-` (one level: a program parents tasks and
   candidates; nothing parents a program). Anything else exits 2.
7. A line whose scope-id has no registry line exits 2: no frame, no scope ( section 3.3).

Exit codes: 0 every line parses and no rule is broken; 1 a well-formed set breaks an independence
rule (P-L1-002); 2 anything the grammar or the reading rules do not accept.

## 4. Grammar examples

These are synthetic inputs, not live assignments. Assume a fixture model registry
where `M` names `sample-model-a` and `sample-alias-a` resolves to that same participant.
The check asks whether M may certify a candidate of `task:x`.

| # | Input | Exit | Contract |
|---|---|---|---|
| F1 | `- reviewer: not reviewer, controller` | 2 (no `@`, a negation, two tokens) | closed input grammar |
| F2 | a fenced `## Roles` with `- M @ task:x: certifier`, then the real `## Roles` with `- M @ task:x: implementer` | 1 (the real line is read, the fenced one is not) | visible Roles section |
| F3 | `## Roles archive` anywhere outside a fence | 2 | visible Roles section |
| F4 | the real line of F2 inside a four-tilde fence that contains two triple-backtick lines, and no other `## Roles` | 2 (no Roles section outside fences) | fence handling |
| F5 | `- M @ task:x: authored` | 2 (`authored` is not a slot) | closed role vocabulary |
| F6 | `- M @ task:x: implementer` and `- sample-alias-a @ task:x: reviewer` | 1 (one participant after the alias resolves, two roles) | R-L1-002.1 |
| F7 | `- sample-model-b @ program:sample: reviewer` and `- sample-model-b @ task:sample-review: critic`, the task's parent being `program:sample` | 0 (the task's own line replaces the inherited one: one role in the frame; the lineage check still applies) | PROTO-DEC-0057 item 3 |
| F8 | `- unknown-model @ task:x: reviewer` | 2 | P-L1-002 stop |
| F9 | `- M @ task:x: owner` | 2 (`owner` is not an assignable slot) | R-L0-04 |
| F10 | `- delegation @ task:x: M until 2000-01-01`, or the same line `by` a block that does not name M | 2 (no owner record the line can be checked against) | section 5 |
| F11 | the frame of `task:x` says `parent-scope: program:gone`, and the registry has no line for `program:gone` | 2 (unresolved parent) | rule 6 |
| F12 | two registry lines for `task:x`, or a frame with two `parent-scope:` fields | 2 | rule 5 |
| F13 | `- M @ task:never-issued: reviewer` | 2 (no registry line) | rule 7 |

The same fence rule applies to producer identity in journals: the producer is read only from the entry's `Launch:` line outside fences
(R-L2-002.5); none found exits 2.

## 5. Delegation (PROTO-DEC-0062 item 3)

For a synthetic example, `- delegation @ program:sample: sample-model-a until 2000-01-01 by <block_id>` lets the named model,
as coordinator, write assignment lines in that scope until that date. Only the owner writes
delegation lines. The text of a line cannot show who wrote it, so the line names the decision block
in which the owner recorded the delegation (to whom, which frames, until when: PROTO-DEC-0062
item 3). The line is accepted only if that block exists in `.ai/DECISIONS.md` outside fences,
carries `Approved by:` and contains the line's model id, scope-id and date; otherwise exit 2. The
`by` field is this draft's proposal for the recorded form that PROTO-DEC-0062 item 3 leaves open.
A delegated coordinator writes assignment lines only, never delegation lines and never a
`coordinator` line (the delegation already names the coordinator; R-L1-coordinator.1), and records
each one in its journal.

## 6. Scope of assignments

Why the certifiers are not program-scope lines: a program-scope line is the default role of its
model in every task of the program that does not name that model (section 2), so a certifier line
there would make the model a certifier by default in tasks where it certifies nothing. A
program-scope line is for a role held throughout the program; a role that changes from task to
task is written at task or candidate scope, and the lineage check of P-L1-002 still catches a
certifier that touched the candidate elsewhere.

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.3 — 2026-10-02
- 0.4 — 2026-10-03
- 0.5 — 2026-10-04
- 0.6 — 2026-10-05
