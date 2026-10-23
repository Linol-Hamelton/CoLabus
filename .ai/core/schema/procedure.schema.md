---
id: SCHEMA-procedure
version: 0.17
title: Shape of every kernel record: front matter, body sections, loading levels
layer: L0
type: schema
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0061, PROTO-DEC-0158, PROTO-DEC-0160, PROTO-DEC-0162, PROTO-DEC-0165, PROTO-DEC-0187]
evidence_class: [B, C]
evidence: [PROTO-DEC-0049]
cost_basis: unknown
---

# Procedure schema

Every kernel record under `.ai/core/` starts with front matter matching this schema. `.ai/bin/protocol-core.cjs` checks the grammar with its lint command. The metadata declares the status and binding basis.

## 1. Front-matter grammar

The front matter is a restricted subset of YAML, so a fixed-grammar parser can read it
without a YAML library (PROTO-DEC-0049 item 2):

```
front_matter ::= "---" LF { field LF } "---" LF
field        ::= key ":" SP value
key          ::= a-z*
value        ::= scalar | list
scalar       ::= <one line, no leading "[", no "#" comment>
list         ::= "[" [ item { "," SP item } ] "]"
item         ::= <token without "," "[" "]">
```

- One field per line. No nesting, no multi-line values, no anchors, no comments.
- Keys appear at most once.
- Exit 2 (unknown input, never guessed): a grammar violation, an unknown key, a value outside
  its enumeration or registry, or a malformed form (a scalar where a list is expected, a bad
  id, `evidence`, `back_edges` or `supersedes` item, a rule id without its anchor).
- Exit 1 (a well-formed record that breaks a rule): a missing required or conditional key,
  missing or misordered required headings, `active` without `owner_approval` and `decision`.
- Order of keys is free; `lint --fix-order` may normalise it, never the values.

## 2. Fields

| Key | Req. | Type | Allowed values / form | Meaning |
|---|---|---|---|---|
| `id` | yes | scalar | `P-L<0-9>-<nnn>`, `S-<nnn>`, `ROLE-<slot>`, `TOOL-<name>`, `APP-<name>`, `M-<nnn>`, `SCHEMA-<name>` | permanent identifier, never reused |
| `version` | yes | scalar | `<major>.<minor>` | major changes meaning; minor clarifies; the front matter version equals the newest change-log line |
| `title` | yes | scalar | one line, ≤ 100 chars | the summary level of loading |
| `layer` | yes | scalar | `L0`..`L9` | the one home layer |
| `type` | yes | scalar | `invariant`, `procedure`, `scenario`, `role`, `tool`, `application`, `metric`, `schema` | kind of record |
| `status` | yes | scalar | `draft`, `review`, `trial`, `active`, `deprecated`, `retired`, `superseded` | lifecycle state (P-L0-001) |
| `roles` | yes | list | role slots from L1, or `all` | who must load it (declared minimum, never a ceiling) |
| `stages` | yes | list | stage ids from section 2.2, or `any` | when it applies |
| `triggers` | yes | list | short tokens, e.g. `signal:procedure-gap`, `owner-directive`, `stage-enter:acceptance` | what starts it |
| `inputs` | yes | list | artifact ids from section 2.1 or repo-relative paths | what it reads |
| `outputs` | yes | list | artifact ids from section 2.1 or repo-relative paths | what it writes |
| `tools` | no | list | `TOOL-*` ids | tools it carries (L3) |
| `back_edges` | yes | list | `<from-step>><to-step>/<budget>/<exit>`, e.g. `7>4/2/owner` | every loop with its source, target, budget and where it exits; `[]` if none |
| `enforcement` | yes | scalar | `S`, `S~`, `P`, `none` | script, partly script, prose only, decided but not built |
| `enforced_by` | cond. | list | repo-relative script paths | required when `enforcement` is `S` or `S~` |
| `script_candidate` | yes | scalar | `yes`, `no:<unmet spec §1 condition number>` | result of the four-condition test |
| `evidence_class` | yes | list | `A`, `B`, `C`, `D`, `E` | why it exists |
| `evidence` | yes | list | `DEC-*`, `PROTO-DEC-*`, `PROTO-DEC-nnnn:<k>` (decision item k), `sig-*`, `path:line`, `path:<a>-<b>` | where the evidence is; prose claims do not count |
| `cost_basis` | cond. | scalar | `attempts=<n>`, `minutes=<n>`, `owner=<n>`, `owner=unknown`, `unknown` | required for class B |
| `trial` | cond. | scalar | `metric=<M-id>; kill=<condition>; until=<YYYY-MM-DD or batch-id>` | required for class C and D while `status: trial` |
| `decision` | cond. | list | `PROTO-DEC-*` | required when the record is binding (`active` and not advisory) |
| `supersedes` | no | list | ids with version, e.g. `<record-id>@<major.minor>`, or `legacy:<path>:<line>` for pre-kernel text | predecessor |
| `superseded_by` | cond. | scalar | id with version | required when `status: superseded` |
| `owner_approval` | cond. | scalar | decision id or `none` | required for `active` |
| `last_applied` | no | scalar | batch id or date | information only; never a reason to retire (PROTO-DEC-0060) |

`cond.` means required under the condition in the Meaning column; `lint` enforces each condition.
`yes` means required for the types that section 3 lists as needing the full key set; section 3
says which keys each type needs. Conditional keys apply to every type without exception.

### 2.1 Artifact ids (preliminary registry)

The owner of this registry is L5. Until stage 5 lands, this list is the
registry, and `inputs`/`outputs` may name only these ids or a repo-relative path:

`task-frame`, `environment-manifest`, `orientation-line`, `candidate-package`, `evidence`,
`findings-ledger`, `attempt-results`, `signals`, `journal`, `stop-question`, `CATALOG`,
`decisions-index`, `review-report`, `record-draft`, `task-intake-record`, `TOOL-registry`.

Five more ids are registered through P-L0-001 in one act (owner) for the
L5-min artifact families: `run-record`, `launch-record`, `brief`, `owner-card`, `owner-words`.
They are PROPOSED: the id is reserved here and in the dictionaries, so `inputs`/`outputs` may
name it and `lint` accepts it, but no artifact of that family is built or issued yet. A registry
row of the artifact schema (SCHEMA-artifact) presents such an id only under the `proposed` label
until the owner act that issues it; `artifact-lint` refuses it as `current` (rule B-L03). The
line below is the machine-readable marker that lint reads.

PROPOSED (registered, not issued; P-L0-001 act pending): run-record, launch-record, brief, owner-card, owner-words.

A new id is added here (and later in L5) through P-L0-001, never by using it first.

### 2.2 Stage ids (preliminary registry)

Owned by L2 once stage 3 lands. Until then `stages` may name only:
`intake`, `frame`, `triage`, `dispatch`, `execute`, `accept`, `freeze`, `close`, `session`,
`research`, or `any`. Added in 0.4 after a stage-1 trial found `research` used and undefined.

## 3. Required body sections, in order

A procedure body is free prose inside these headings. `lint` checks that the headings exist
and are in order; it never parses the prose.

1. `## Purpose` — one paragraph: the failure class it prevents or the gain it produces.
2. `## Rules` — numbered atomic rules, each `<rule-id>. <one normative sentence>`. Rule ids are
   anchored:
   - in L0, `R-L0-<nn>` is a rule of the root (`L0-ROOT.md`), and a procedure's rules are its
     sub-rules `R-L0-<nn>.<k>`; the root must define `R-L0-<nn>`;
   - in every other layer, the anchor is the record's own id without its type prefix:
     `R-L2-008.<k>` in P-L2-008, `R-L2-S003.<k>` in S-003, `R-L1-certifier.<k>` in ROLE-certifier;
     the record is the anchor, and no separate root line is needed;
   - a rule id is defined once, in one record (LCC-1).
3. `## Steps` — numbered steps; each names its actor slot, input and output.
4. `## Stop conditions` — when to stop and go to P-L0-002.
5. `## Back edges` — prose for each `back_edges` entry.
6. `## Evidence` — the dossier: one line per class entry with its reference and cost.
7. `## Risks` — table in the PROTO-DEC-0049 item 4 form: risk, likelihood, impact, coverage,
   cost, residual.
8. `## Change log` — one line per version: version, date, author session, reviewer, decision.

Required keys and headings by type:

| Type | Required front-matter keys | Required `##` headings, in this relative order |
|---|---|---|
| `procedure`, `tool`, `application`, `metric` | every key marked `yes` in section 2 | the eight above |
| `scenario` | every key marked `yes` | the eight above, plus `Stage graph` and `Handoff artifacts` after `Steps` |
| `role` | every key marked `yes` except `back_edges` | `Purpose`, `Rules`, `Rights`, `Duties`, `Limits`, `Procedures`, `Evidence`, `Risks`, `Change log` |
| `invariant` | `id`, `version`, `title`, `layer`, `type`, `status`, `roles`, `stages`, `triggers`, `enforcement`, `script_candidate`, `evidence_class`, `evidence` | `Purpose`, `Rules`, `Evidence`, `Change log` |
| `schema` | `id`, `version`, `title`, `layer`, `type`, `status`, `evidence_class`, `evidence` | `Change log` |

- Conditional keys (`enforced_by`, `cost_basis`, `trial`, `decision`, `superseded_by`,
  `owner_approval`) apply to every type, including `invariant` and `schema`.
- Other `##` headings may appear between the required ones. `lint` checks only that the
  required headings exist and keep this relative order.
- `###` subheadings are free.

### 3.1 Text of a rule and of a free-text value

"Carries text" has ONE definition, implemented once in `.ai/bin/lib/records.cjs` (`textOf`, `hasText`, `ruleText`) and
called by `lint`, LCC and `compile-packet`; no consumer keeps a filter of its own. The text of a value is what a reader
sees after: (a) every Default_Ignorable_Code_Point character is removed (zero-width marks, the Hangul and Khmer
fillers, variation selectors, tags: several of them are letters to a regex and render as nothing); (b) HTML comments and
numeric entities are removed or decoded; (c) a CommonMark backslash escape before ASCII punctuation is the literal
character and never markup; (d) the content of a code span is literal (an empty code span is empty; a comment or an
entity inside a non-empty one is visible text). The value carries text when at least one Unicode letter or digit remains.

- A rule line is `<rule-id>. <text>`: a marker followed by no text (`R-L0-01. .`, a dash, an empty code span or
  comment, invisible characters) is a hollow rule. It is not a rule: `lint` reports it as F10 and it never counts.
- Paths and globs (the `scope`, `forbidden` and `sources` entries of a task frame) only need to be non-empty after the
  same reduction, and an entity there is the literal name (`literal` mode), because `**` is a legal glob.
- The sentinels `parent-scope: -` and `non-goals: []` are named values, not emptiness.
- The closed list of forms that must be refused or accepted has 100 rows; it is the
  acceptance table of this section.

## 4. Loading levels

Levels of loading, not of permission; reading is never forbidden (L0 R-L0-09). Two commands deliver kernel
text and both use these levels: `packet` measures whole files (4.1), `compile-packet` builds the instruction an
agent receives (4.2).

| Level | What an agent receives | Source |
|---|---|---|
| exists | `id`, `title` | CATALOG line |
| summary | exists + `roles`, `stages`, `triggers`, `status` | CATALOG line |
| pointer | one line: record id, the trigger, `<path>#<section>` ("if <trigger>: open <path>#<section>") | the compiler |
| fields | the field or stage tables of a schema or scenario | the file's sections |
| operational | the operational sections of the file (4.2), rule lines verbatim with their ids | the file's sections |
| full | the whole file | the file |

### 4.1 Whole-file packet (command `packet`; LCC-8 and LCC-8c)

A packet loads `full`:
- the root;
- records whose `roles` name the slot explicitly and whose `stages` name the stage or `any`;
- schema records named in the `inputs` of those records.

Records with `roles: [all]` apply to everyone but load at `summary` level; each one is opened
in full when its trigger fires, and the root names where to go for each trigger. Everything
else loads at `summary`. This keeps material outside the active role and stage
from consuming the full-file budget. The packet budget is 100,000 B.

### 4.2 Compiled instruction (command `compile-packet`; PROTO-DEC-0162, PROTO-DEC-0165)

The compiler is a deterministic script: rule lines are copied byte for byte with their ids, never paraphrased;
the same inputs give the same bytes.

Operational sections by type (everything else - front matter, `Evidence`, `Risks`, `Provenance`, `Change log`
and any `Alternatives` - stays out of the instruction; the file itself stays whole for a direct reader):

| Type | Operational sections |
|---|---|
| `procedure`, `tool`, `application`, `metric` | `Rules`, `Steps`, `Stop conditions`, `Back edges` |
| `scenario` | as a procedure, plus `Stage graph`, `Handoff artifacts` |
| `role` | `Rules`, `Rights`, `Duties`, `Limits`; `Purpose` as its first sentence |
| `invariant` | `Rules` |
| `schema` | the field and table sections (`fields` level) |

Selection, for one (role, stage) pair: the root (operational); `ROLE-<slot>`; records whose `roles` name the slot
and whose `stages` name the stage or `any` (operational); schema records in the `inputs` of those, one hop
(`fields`); records with `roles: [all]` or a trigger the task-frame fires, at `pointer` (operational once the
trigger has fired); every other record at `exists`. A record is included when its status is `active`; `trial`
records only on an explicit request, with a banner; `draft` records are never included. The instruction names
the binding basis
(`owner_approval`) of every record it includes. A packet is for one pair; several pairs are several packets.

Budget: a soft target in estimated tokens (owner-tunable; a per-client override lives in `.ai/docs/clients.json`)
decides when the compiler degrades; the byte gate of 4.1 stays the one hard gate. Estimated figures are
labelled as estimates. Priorities, from the last to degrade to the first:
- P0, never degraded: the root rules, the mandatory rules of the role and stage, `Rights`, `Duties`, `Limits`,
  `Stop conditions`, and the `Steps` of the primary procedure (the record whose `stages` name the current stage
  explicitly);
- P1: `Steps` of records with `stages: [any]` (to a pointer);
- P2: `Back edges` first, then the rules of records included only by a fired trigger; below these: `Handoff
  artifacts`, `fields` to names only, pointers to `exists`, `exists` dropped.
A client that cannot open a file never gets a pointer in place of text: it gets the full text, or the compile
fails the budget with a named report. Every degradation is a row of the packet manifest.

Layout: a constant authority line first (`AGENTS.md` and `.ai/DECISIONS.md` outrank the packet), then a fixed
block order that carries no value depending on the tree; the identity line (tool, tree digest, packet hash) is
the last line and also sits in the manifest, so a change of one record does not move the cached prefix.

### 4.3 Load profiles (command `compile-packet --profile`; hand-kept table until L5 and L6)

A light task must not receive the instruction of a heavy one. The compiled instruction has four load levels; level 4 is the whole
instruction of 4.2 and stays the default while it fits the byte gate (100000 bytes), so a call without `--profile` is then byte for byte what it was.
A default call whose whole instruction is over the gate is not refused: the compiler takes the first of the levels 3, 2, 1 that fits and records it
(`degraded` rows of the step `profile-<level>` and a `profile` object with `requested: default` in the manifest); only when level 1 does not fit either is it
refused with the named reason (PROTO-DEC-0187 item 1: the limit stays 100000 bytes, the profiles are reduced, never the limit raised). A call that names `full` or `4`
is never reduced; it is refused when over the gate.

| Level | What the agent receives | Everything else |
|---|---|---|
| 1 team | the team rules of the root (the `team-rules` line below), the role (`Purpose` first sentence, `Rules`, `Rights`, `Duties`, `Limits`), the `Stop conditions` of the records that name the stage | pointers (a client without file access: dropped) |
| 2 work | level 1 plus `Rules`, `Steps` and `Stop conditions` of the records that name the stage | other blocks to pointers |
| 3 extended | all P0 and P1 blocks of 4.2 | P2 and P3 blocks to pointers |
| 4 full | everything of 4.2 | nothing is cut |

`--profile auto` takes the level from the `tier` of the task-frame (T1..T9, P-L2-002) and the role: the table below. `--profile 1|2|3|4|full`
sets the level by hand. A rule asked for with `--needs-rules` is never cut, also a rule of the root. A frame that fails the frame lint (a missing or malformed `tier`) is refused by the frame gate with exit 1 before any profile logic; `--profile auto` with no frame at all is exit 2. The `team-rules` line must name rules that exist in the root, appear once, and the compiler checks that when a light level uses it. A role without a row, or a missing block, means level 4: the
profile can lower what an agent loads only on an explicit row. Every cut is a row of the packet manifest (`degraded`, step `profile-<level>`) and
the manifest records the requested profile, the tier and the level.

<!-- selection-policy:begin -->
<!-- Generated from docs/ops/selection-policy.json sha256:d08bdfcbfa0f2518620984739a58cbde932e563c84086ec84b30aed232dd758f; do not edit. -->
```profiles
team-rules: R-L0-01, R-L0-03, R-L0-04, R-L0-05, R-L0-06, R-L0-07, R-L0-08, R-L0-09, R-L0-10, R-L0-11, R-L0-16
implementer: T1-T3=1, T4-T6=2, T7-T9=3
fixer: T1-T3=1, T4-T6=2, T7-T9=3
drafter: T1-T3=1, T4-T6=2, T7-T9=3
synthesiser: T1-T3=1, T4-T6=2, T7-T9=3
owner: T1-T6=1, T7-T9=2
researcher: T1-T3=2, T4-T9=3
reviewer: T1-T3=2, T4-T6=3, T7-T9=4
critic: T1-T3=2, T4-T6=3, T7-T9=4
coordinator: T1-T3=2, T4-T6=3, T7-T9=4
dispatcher: T1-T3=2, T4-T6=3, T7-T9=4
certifier: T1-T3=3, T4-T9=4
shadow-certifier: T1-T3=3, T4-T9=4
auditor: T1-T3=3, T4-T9=4
procedure-author: T1-T3=3, T4-T9=4
```
<!-- selection-policy:end -->

## 5. Examples

Valid:

```
---
id: P-L0-002
version: 0.1
title: Stop and ask when a rule is missing, conflicting or blocked
layer: L0
type: procedure
status: active
roles: [all]
stages: [any]
triggers: [rule-not-found, source-conflict, tool-blocked, scope-exceeded]
inputs: [journal]
outputs: [stop-question, journal]
back_edges: []
enforcement: P
script_candidate: no:1
evidence_class: [A, C]
evidence: [PROTO-DEC-0061]
---
```

Invalid, with the exit each produces:

| Front matter | Exit | Why |
|---|---|---|
| `roles: certifier` | 2 | list expected, scalar given |
| `status: approved` | 2 | not in the enumeration |
| `enforcement: S` without `enforced_by` | 1 | conditional field missing |
| `evidence_class: [B]` without `cost_basis` | 1 | class B needs its cost |
| `evidence: [we saw this often]` | 2 | not an id or `path:line` |
| a nested `roles:` block on several lines | 2 | nesting is outside the grammar |

## 6. Dictionaries

The single machine-readable source of every enumeration and registry `protocol-core.cjs` enforces
(its dictionaries): the artifact ids of 2.1, the stage ids of 2.2, the role slots of section 2, the
`type`, `status`, `enforcement` and `evidence_class` enumerations, and the finding codes that make
lint exit 2 (malformed input). The code reads this block and keeps no literal copy of it. The
schema is read only from its canonical location under the scanned root; no copy
travels with the tool. A missing
file, a missing block, a missing dictionary or a malformed line is a named exit 2, never a
guessed default.

The block is the fenced `dict` code below: one `name: item, item, ...` line per dictionary, items
separated by `", "`, no other syntax.

`triggers` is the registry of the trigger tokens a record or a task-frame may name (65 at 0.13, seeded from the kernel records); its items may also contain `:`. It is optional for the tool: a corpus
without it loads, and the compiler then refuses every frame trigger (exit 2). A new token is added here in the
same act that first uses it.

```dict
types: invariant, procedure, scenario, role, tool, application, metric, schema
statuses: draft, review, trial, active, deprecated, retired, superseded
enforcement: S, S~, P, none
evidence_class: A, B, C, D, E
artifacts: task-frame, environment-manifest, orientation-line, candidate-package, evidence, findings-ledger, attempt-results, signals, journal, stop-question, CATALOG, decisions-index, review-report, record-draft, task-intake-record, TOOL-registry, run-record, launch-record, brief, owner-card, owner-words
stages: intake, frame, triage, dispatch, execute, accept, freeze, close, session, research, any
roles: owner, coordinator, implementer, reviewer, certifier, shadow-certifier, auditor, researcher, synthesiser, drafter, critic, fixer, procedure-author, dispatcher, all
triggers: action-complete, action-not-named-by-step, before-owner-question, budget-exhausted, candidate-frozen, candidate-ready, capability-missed, corpus-cover, corpus-dup, critiques-ready, decision-lookup, discovery-unranked, dispatch, draft-ready, frame-close, frame-closure, frame-gap, frame-gate, frame-open, frame-round, gate-run, incident, install, owner-approval, owner-directive, package-freeze, premise-wrong, program-exit, record-change, reopen-trigger, research-consensus, retirement-candidate, review-finding, role-assignment, round-3, route-failure, rule-not-found, scenario-gap, scope-exceeded, session-end, session-start, signal:budget-exhausted, signal:defect-found, signal:fall, signal:kernel-change, signal:procedure-gap, signal:script-candidate, source-conflict, source-missed, stage-3-start, stage-enter:accept, stage-enter:dispatch, stage-enter:execute, stage-enter:frame, stage-enter:freeze, stage-enter:triage, stage-exit, stop-question, task-intake, tool-blocked, tool-change, tool-invoked, trial-kill, upgrade, verdict:FAIL
exit2: F1, F4, F5, F6, F9, F10
```

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-09-24
- 0.4 — 2026-09-24
- 0.5 — 2026-09-24
- 0.6 — 2026-09-24
- 0.7 — 2026-09-27
- 0.8 — 2026-10-01
- 0.9 — 2026-10-01
- 0.10 — 2026-10-01
- 0.11 — 2026-10-04
- 0.12 — 2026-10-05
- 0.13 — 2026-10-05
- 0.14 — 2026-10-05
- 0.15 — 2026-10-06
- 0.16 — 2026-10-08
- 0.17 — 2026-10-14
