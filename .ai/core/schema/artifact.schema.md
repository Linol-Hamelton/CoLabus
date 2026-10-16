---
id: SCHEMA-artifact
version: 0.4
title: L5-min artifact families - identification, closed field sets and error classes (W1 PKG-D)
layer: L5
type: schema
status: draft
roles: [procedure-author, reviewer]
stages: [any]
triggers: [record-change, owner-directive]
inputs: [.ai/core/schema/procedure.schema.md]
outputs: [.ai/core/schema/artifact.schema.md]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [B]
cost_basis: unknown
evidence: []
---

# Artifact schema

This draft record describes artifact identification and wire forms. Inclusion in the product does not activate the reserved artifact families or grant authority to issue them. The artifact-lint command of `.ai/bin/protocol-core.cjs` remains advisory: exit 0 certifies nothing and closes no completion gate.

## Purpose

One artifact, one home, one writer, one closed field set per family. The failure class is a
record whose family cannot be told from another, whose fields are guessed instead of refused,
or whose identifier collides with an existing file. The schema fixes, once, how a consumer
tells each declared family apart and which fields it must carry, so that identification and
validation are the same act on every reader (X1, lint rule B-L26).

## Rules

- R-L5-artifact.1. A record belongs to a family by its external artifact home and the grammar of the identifiers it carries, never by a second value of another family's field.
- R-L5-artifact.2. The field sets below are closed: a required field missing is a rule violation (exit 1); an unknown, extra or malformed field is malformed input (exit 2).
- R-L5-artifact.3. Kernel front-matter fields (status, version, change log, supersedes) belong to `.ai/core/` records only; they are never imported into a channel record or the owner-words form.
- R-L5-artifact.4. An identifier is permanent and never reused; a present identifier outside its declared grammar is malformed (exit 2).
- R-L5-artifact.5. Fail-closed: a missing dictionary, registry, schema or required input is a named exit 2, never a guessed value or a default.
- R-L5-artifact.6. The lint is advisory and closes no security gate: a structurally correct but false header is outside its power.

## Families and identification (B-L26)

| Family | External home | Identification | Closed field set (source) |
|---|---|---|---|
| F-REG | a registry row of AH section 1 | a `registry` block row: label + the seven AH fields | label, artifact, home, id, writer, reader, schema, source |
| F-OWORDS | the tracked append-only journal in `docs/ops/` | a `record` block carrying `word-id` | the nine OW section 2 fields |
| F-CARD | an owner card | a `record` block carrying `card-id` | the seven OW section 1 fields (anchor is conditional on binding.kind) |
| F-BRIEF | the brief output (payload + envelope) | a `brief` block carrying the envelope line `== state-brief <UTC> ==` | state-header plus tree, registry-open, launches, tasks, freshness, unknowns |
| F-RUN | `docs/ops/RUNS.jsonl` | a JSONL record with `schema = run-record/1` | its own schema; the lint checks only channel discipline (B-L09) |
| F-LAUNCH | the launches `LAUNCHES.jsonl` | a JSONL record with `schema = launch-record/1` | its own schema; the lint checks only channel discipline (B-L09) |
| F-KERNEL | a record under `.ai/core/` | front-matter `type` | out of the artifact lint's subject; `protocol-core.cjs lint` owns it |

- The channel records keep their own key order and unknown-key rule; `artifact-lint` neither adds nor requires `version`, `kind` or a change log on them (R-LS-6).
- The current/proposed label is registry metadata, never an eighth payload field of run-record/1 or launch-record/1 (B-L03).
- `home` (F-REG) is a declared home string of AH section 1, not a path form: the lint checks only that it is present (B-L01) and compares it across rows for B-L07; it never resolves, opens or dereferences it. Only `id` carries a path form (repo-relative, B-L02).
- An empty required cell of a registry row is the missing-required case (B-L01, exit 1), one finding; no second code is raised for the empty value, and a row without an id joins no B-L07/B-L08 group.
- B-L07/B-L08 are reported once per duplicated id (at the id's first row), with the count of distinct homes or writers and at most ten example values; the report stays bounded and linear in the input (R-EC-2: every duplicated id is still reported, the exit class stays 1).

## Wire forms the lint reads

The lint reads declared families from fenced blocks with a family keyword; a JSONL file is a channel.

```registry
| label | artifact | home | id | writer | reader | schema | source |
|---|---|---|---|---|---|---|---|
| proposed | owner-words | docs/ops/owner-words.md | owner-words | operator | coordinator | owner-words | OW §2 |
```

Illustrative record values below are synthetic; the host must supply its own
approved basis file before treating a record as authorisation.

```record
word-id: OW-20000101-01
date-utc: 2000-01-01T00:00:00Z
owner: owner
provenance: direct
binding: standing
scope: budgets
excluded: none
addendum-ref: docs/ops/OWNER-ADDENDA.md
links: 
```

```brief
== state-brief 2000-01-01T00:00:00Z ==
tree: main 40hex clean
registry-open: none
launches: none
tasks: none
freshness: fresh
unknowns: none
```

- The `binding` field of an owner-words record has one grammar, read by `artifact-lint` (B-L13, B-L15) and by the validator's rule-20 check (CM-71, PKG-E) through one parser (`.ai/bin/lib/artifacts.cjs` parseBinding): `standing`; `candidate@<branch>@<40-hex sha>`, optionally followed by the word's own void clause `; void-on:registry-row` (the P-13 binding of the void to the registry row) or `; void-on:new-commit`; `plan@<64-hex sha256>@<40-hex publication commit>`. A clause on a standing or plan word, a short or malformed sha, an anchor without a branch, or an unknown clause is malformed (B-L13, exit 2). The validator reports a candidate anchor behind its branch head as a divergence always, and as void only when the clause is `void-on:registry-row` (B-L14); it never reads `.ai/runtime`, so the registry comparison stays the operator's manual gate (OW R-20-2).
- The `brief` envelope is volatile and never enters the payload comparison or the digest (B-L06).
- A missing envelope line is a parse failure (exit 2); a missing required payload field is nonzero with the exact code deferred to W3 (R-EC-1).

## Error matrix (R-EC-3, proposed codes)

Cell by cell the matrix of  section 3 (R-EC-3,
rev 0.4). Every deliberate difference is stated in the numbered notes below the table, never
silently.

| Family | missing required | present malformed | unknown/extra field | unissued id as issued | wrong policy label (current/proposed) | two homes / writers | parse failure | explicitly out of subject |
|---|---|---|---|---|---|---|---|---|
| F-REG | 1 (B-L01, Y1) | 2 (B-L01) | 2 (B-L01) | 2 (B-L02) | 1 (B-L03, Y2: policy, not grammar) | 1 (B-L07 homes / B-L08 writers) | 2 (R-LS-4; note 1) | - |
| F-OWORDS | 1 (B-L04, B-L26) | 2 (B-L05, B-L13) | 2 (B-L24) | 2 (B-L02; note 2) | - (the label is registry metadata, not a record field, B-L03) | 1 (B-L08) | 2 (R-LS-4; note 1) | version/changeLog/supersedes are never introduced (R-LS-6) |
| F-CARD | 1 (B-L25, B-L26) | 2 (B-L25: status/options/default outside the form) | 2 (B-L24) | 2 (B-L02) | - (as F-OWORDS) | 1 (B-L08) | 2 (R-LS-4; note 1) | version/changeLog are never introduced (R-LS-6) |
| F-BRIEF | payload: nonzero, code UNKNOWN until W3 (B-L06, R-EC-1); state-header missing: parse failure 2 (B-L06) | 2 (note 3) | 2 (B-L24) | 2 (B-L02) | - (the label is not a brief field; no eighth field, R6) | 1 (B-L18: live time inside the payload) | 2 (missing or broken state-header, B-L06, STATE-BRIEF section 4) | digest algorithm UNKNOWN until W3 (R-BL-3) |
| F-RUN / F-LAUNCH | - (their own schemas reject missing/unknown/malformed, R-LS-6) | - | - | 2 (B-L02, in a registry row, never in the channel record) | - (the label is not a channel field, R-LS-6) | 1 (B-L09, channel separation only) | - (their own validators) | all channel record content |
| F-KERNEL | out of the lint's subject entirely (R-LS-1, R-BL-3): its missing/malformed/unknown codes are set by procedure.schema.md section 1 and checked by `protocol-core.cjs lint` | | | | | | | |
| DOC declarations / examples | - | - | - | 2 (an example token used as an id in links, B-L02) | 1 (an example without the PROPOSED-NOT-ISSUED marker, R5; note 4) | - | - | budgets are not schema fields (R-OB-1); K5 text (sibling B-S34) |

- Exit is the worst class found; every finding is reported, the first never suppresses the rest (R-EC-2). A WARN never raises the exit.
- The codes are the lint specification's proposed classes; AH, OW and SB set forms, not exit codes. B-L18 has one exit class, 1 (the specification's rule row), and appears in one cell only.
- Note 1 (parse failure, deliberate addition): the specification cites R-LS-4 (fail-closed, a named exit 2) for an unparsable F-REG, F-OWORDS or F-CARD form. This record keeps that class and adds the encoding case under its own rule: a BOM or CRLF in a file the lint reads is reported as R-LS-7, exit 2 (the code the implementation emits); R-LS-4 stays the code for a missing dictionary, registry or input, and for the one unparsable wire form the implementation recognizes: a fenced `registry`, `record` or `brief` block without its closing fence is reported as R-LS-4, exit 2, at the opening fence (the form is never read partially).
- Note 2 (F-OWORDS unissued id, deliberate omission): the specification's matrix also names B-L17 in this cell. This record omits it: the specification's own rule row assigns B-L17 exit 1 (an id collision is a rule violation, not malformed input) and its coverage table R-BL-3 lists neither B-L02 nor B-L17 for owner-words; the implementation follows the rule row and raises B-L17 on registry rows with exit 1. The disagreement inside the specification is a reconciliation card for its author (R-WI-3), not a silent merge here.
- Note 3 (F-BRIEF present malformed): the specification assigns 2 without a rule id. The implementation reports a malformed state-header UTC under B-L06 (exit 2).
- Note 4 (DOC row): quoted from the specification in full, including its out-of-subject cell (budgets, R-OB-1; the K5 text of the sibling's B-S34). `artifact-lint` reads fenced wire blocks and JSONL channels only (R-LS-8) and does not evaluate examples in prose; the marker rule R5 is not implemented in PKG-D.
- Note 5 (identifier reuse, R-L5-artifact.4 / B-L05): "never reused" is declared, not enforced; the specification's matrix assigns no code to a word-id or card-id repeated across records or files, and the lint raises none (W3 reconciliation; a code needs the specification first).

## Evidence

This record specifies family identification and the error matrix for each declared
family. The matrix states the consumer contract and its explicit implementation gaps;
this product does not include the source design dossiers or certify their closure.

## Risks

| Risk | Likelihood | Impact | Coverage |
|---|---|---|---|
| the two DRAFT halves drift again | medium | medium | the identification rule and the error matrix live here once; each half points to it |
| the PROPOSED id `brief` collides with the live helper name | high | low | flagged by lint rule B-L17; R-SB-1 keeps helper and artifact distinct |
| the owner-words journal wire form is not yet fixed by the owner | medium | medium | the form here is the lint's declaration, not an owner act; a change needs a new version |
| the brief payload code is deferred to W3 | certain | low | R-EC-1 keeps the code UNKNOWN; the lint does not invent it |

## Change log

- 0.1 — 2026-10-08
- 0.2 — 2026-10-08
- 0.3 — 2026-10-08
- 0.4 — 2026-10-08
