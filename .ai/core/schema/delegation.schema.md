---
id: SCHEMA-delegation
version: 0.4
title: Shape of a delegation record - who may do what, in which scope, until when (L5)
layer: L5
type: schema
status: active
owner_approval: PROTO-DEC-0183
decision: [PROTO-DEC-0183]
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0062:3, PROTO-DEC-0049:2, .ai/core/schema/assignment.schema.md:115-124, .ai/core/schema/artifact.schema.md:47-52]
---

# Delegation record schema (L5)

Draft record: a delegation is an L5 artifact. Not binding: a draft
record is advisory until the owner approves it (R-L0-17.6, R-L0-17.7). It defines one record shape
and builds nothing new where L5 and L1 already have a rule:

- the wire discipline is SCHEMA-artifact's (R-L5-artifact.2 closed field set, exit 1 for a missing
  required field and exit 2 for an unknown or malformed one; R-L5-artifact.5 fail-closed on a
  missing input); the family is told apart by its own fence keyword and identifier
  (R-L5-artifact.1), so `artifact-lint`, which reads only `registry`, `record` and `brief` blocks,
  never mistakes it for an owner-words record;
- the authority rule is SCHEMA-assignment section 5: only the owner delegates, and the record names
  the decision block in which the owner did so; the block must contain the grantee, the scope-id and
  the date. "Contain" is positive: the block states the grant as live `Grant-*`
  lines (section "Basis"), and the record may only narrow it. A role delegation stays a `- delegation @` line of SCHEMA-assignment; this record is for
  actions (an owner question of the L8 audit stays open: one home or two).

The checker is `.ai/bin/protocol-delegation.cjs` (`lint`, `check`).
Nothing calls it; it is advisory and closes no gate. Like the other
schemas it names no roles or stages: it is loaded through the `inputs` of P-L8-001, so it does not
enlarge any role's whole-file packet.

## Rules

- R-L5-delegation.1. A delegation record is a fenced block with the info string `delegation`, at column 0, holding only `key: value` lines of the nine fields below, each exactly once.
- R-L5-delegation.2. A missing field breaks a rule (exit 1); an unknown or repeated field, a line outside `key: value`, a value outside its grammar, or an unreadable file form is malformed (exit 2).
- R-L5-delegation.3. The field `by` names a decision block of `.ai/DECISIONS.md` whose one live heading is `### <id>` and whose live statements (section "Basis") are exactly one `Status: Accepted`, one `Approved by:` naming a person, one valid `Date:` and the six `Grant-*` lines, each once and inside its grammar; the approver's identity token must be a name of the closed owner list in the project data (`.ai/docs/owners.json`: a data file, never code; a name outside it or an absent, unreadable or malformed list refuses - unknown never approves); anything else, including any statement-like line in the block that is not live, is malformed (exit 2).
- R-L5-delegation.4. A delegation holds from `date-utc` through 23:59:59Z of `until`, for the listed verbs, on the listed scope paths minus the excluded ones, for the named grantee in the named scope only, and only where the owner's grant holds too; everything else is refused.
- R-L5-delegation.5. A delegation-id is never reused, a record is never edited, and a record whose basis a live `Supersedes:` line later in the document names is withdrawn (an earlier or quoted line withdraws nothing; a statement-like line that is not live leaves the revocation unknown, exit 2); each of these makes the record unusable, never a pass.
- R-L5-delegation.6. The checker reads no clock and guesses no value: the instant of the action is an input, and a requested path, every scope item and every excluded item are judged by the same real-path rule inside the repository root; a requested path with a link (symbolic link, junction, or a file with more than one hard link) in itself or any ancestor is refused, a scope item through a link covers nothing, and an excluded item excludes both its written and its real form. An excluded path excludes itself and everything below it, with or without the trailing slash, so no spelling of the name frees the path. A file-system error other than "does not exist" (an unreadable component such as EACCES, a file in the middle of the path such as ENOTDIR) is UNKNOWN: the path is refused, never read as a missing component and never a pass.
- R-L5-delegation.7. A record may only narrow the owner's grant: the same grantee and scope-id, its verbs a subset of `Grant-verbs`, each scope item inside a `Grant-scope-paths` item and outside every `Grant-excluded` item, every `Grant-excluded` item inside its scope also excluded by the record, `until` no later than `Grant-until` and `date-utc` no earlier than the decision `Date`; a wider record breaks a rule (exit 1) and is unusable, and `check` applies the grant as well as the record.
- R-L5-delegation.8. A statement of the decision log is live only as a `Key: value` line at column 0 in a paragraph of such lines, outside fences, HTML blocks and comments, indented code, quotes, lists, tables, setext headings and code spans or inline HTML of its paragraph; an unclosed fence or HTML block makes the whole log unreadable (exit 2).

## Fields

| Field | Grammar | Meaning |
|---|---|---|
| `delegation-id` | `DG-YYYYMMDD-NN`, a valid date | permanent identifier |
| `date-utc` | `YYYY-MM-DDTHH:MM:SSZ`, a valid instant | when the delegation starts to hold |
| `grantee` | `a-z0-9{1,63}` | who: one participant token (a model id of the model matrix, a session owner name or a role slot); compared exactly |
| `scope-id` | SCHEMA-assignment `kind:name` (`program:`, `task:`, `candidate:<40-hex>`) | which frame the delegation belongs to |
| `scope-paths` | items separated by `, `; each a repository path or a directory prefix ending in `/` | where: the paths the verbs apply to |
| `excluded` | `none`, or items as in `scope-paths` | paths carved out: the path itself and everything below it, with or without the trailing `/`; compared without case, so a case variant never escapes |
| `verbs` | distinct items of `edit, create, move, delete, commit, tag, merge, push` | what |
| `until` | `YYYY-MM-DD`, a valid date (the SCHEMA-assignment `date`) | until when, inclusive of the whole UTC day |
| `by` | `PROTO-DEC-nnnn` or `DEC-nnnn` | the owner record (SCHEMA-assignment section 5) |

## Basis

The decision block that `by` names states the grant in its metadata paragraph, one live
statement per line, each exactly once (the approver is one identity token of at least two
capitalised parts, the form the decision log uses, optionally followed by ONE closed
` (provenance)`: non-empty, no parenthesis inside, nothing after the closing one; and the token
must be a name of the closed owner list of the project data `.ai/docs/owners.json`, which holds
exactly one `owners` array - a name outside it or an absent list refuses):

~~~text
### PROTO-DEC-nnnn

Status: Accepted
Approved by: OwnerName (direct owner confirmation, YYYY-MM-DD, transcribed by <session>)
Date: 2026-10-10
Grant-grantee: claude-opus-5-5
Grant-scope-id: task:l8l9-rules
Grant-scope-paths: .ai/core/L8-access/, .ai/core/L9-code/
Grant-excluded: none
Grant-verbs: edit, create, commit
Grant-until: 2026-10-13
~~~

The `Grant-*` values follow the grammars of the record fields of the same name. A statement in
prose, in a quote, in a fence or in any other form is not read; a statement-like line that is not
live (a look-alike letter, an invisible or odd space, a lazy continuation, a padded value) is
unknown and refuses the basis. On the decision log of 2026-10-10, 153 of 180 blocks read as
accepted, approved and dated under this rule; the other 27 wrap a metadata line, start a prose line
with `status:`, or are not accepted. No block carries `Grant-*` lines yet, so no live right
passes the check until the owner writes one.

Path item grammar: segments of `[A-Za-z0-9._@+-]`, separated by `/`; no `.` or `..` segment, no
segment ending in a dot, no leading `/`, no drive, no `:` and no `~`. There is no glob: masks are
an open owner question of the L9 audit, and `protocol-scope.cjs` compares literals and prefixes, so
the record uses the form both tools read. The verbs cover actions inside the repository only; a
change outside the repository (verb `configure-outside` of the L8 proposal) has no record form yet
(P-L8-001, gap list).

Example (the decision id is a placeholder; the checker refuses it until a real block names it):

~~~text
```delegation
delegation-id: DG-20261010-01
date-utc: 2026-10-10T08:00:00Z
grantee: claude-opus-5-5
scope-id: task:l8l9-rules
scope-paths: .ai/core/L8-access/, .ai/core/L9-code/
excluded: none
verbs: edit, create, commit
until: 2026-10-13
by: PROTO-DEC-nnnn
```
~~~

## Error matrix

| Case | Code | Exit |
|---|---|---|
| missing field | D-01 | 1 |
| unknown field, a line outside `key: value` | D-02 | 2 |
| repeated field | D-03 | 2 |
| value outside its grammar | D-04 | 2 |
| `until` before `date-utc` | D-05 | 1 |
| reused `delegation-id` | D-06 | 1 |
| `by` unresolvable, the log unreadable, or the basis statements not exactly as in "Basis" | D-07 | 2 |
| basis named by a later live `Supersedes:` line | D-09 | 1 |
| a later statement-like `Supersedes:` line naming the basis that is not live | D-09 | 2 |
| record wider than the grant (R-L5-delegation.7) | D-10 | 1 |
| BOM, CR, NUL, invalid UTF-8, a fence outside the closed fence grammar, an unclosed fence, a `delegation` fence not after a blank line, an HTML line | D-08 | 2 |

`check` decides nothing on a malformed file (exit 2), skips every record with a finding, and answers
per path: ALLOW (`COVERED`) or REFUSE with one reason of `NO-DELEGATION`, `SCOPE-ID-MISMATCH`,
`VERB-NOT-GRANTED`, `NOT-YET-VALID`, `EXPIRED`, `EXCLUDED`, `OUT-OF-SCOPE`, `OUTSIDE-ROOT`, `LINK`.
An exclusion of any holding record of the same grantee and scope-id, and of its grant, applies.
The whole action is allowed only when every path is.

## Home of the records

Proposed: one delegation register, append-only, written by the operator under the shared-document
lock (L8 proposal section 3.1). Not created by this draft: no owner word fills it yet, and the
artifact id `delegation` is not registered in procedure.schema.md section 2.1 (a P-L0-001 act, the
finding of the L8 audit). The records this draft and its tests read are fixtures.

## Change log

- 0.1 — 2026-10-10
- 0.2 — 2026-10-10
- 0.3 — 2026-10-11
- 0.4 — 2026-10-14
