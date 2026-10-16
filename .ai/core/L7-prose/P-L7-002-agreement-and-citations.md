---
id: P-L7-002
version: 0.6
title: Agreement grammar and citation detector - closed forms for endorsing and citing another text
layer: L7
type: procedure
status: active
owner_approval: PROTO-DEC-0183
decision: [PROTO-DEC-0183]
roles: [reviewer, certifier, critic, synthesiser]
stages: [accept, research]
triggers: [critiques-ready, round-3, review-finding, candidate-ready]
inputs: [review-report]
outputs: [review-report, journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [PROTO-DEC-0048:3, PROTO-DEC-0048:5, PROTO-DEC-0169:3, .ai/core/L0-meta/P-L0-008-research-governor.md:169]
cost_basis: unknown
---

# P-L7-002 Agreement grammar and citation detector

Draft of CORE-ARCH stage 6, task S6-T01 ( section 2, R-04; owner instruction  item 5).
Status is draft: review, activation and any binding effect wait for the owner's act (R-L0-17.6). The roles
that already point here (ROLE-critic, ROLE-synthesiser, R-L2-S003.4) find the form in this record.
`enforcement: none` until `.ai/bin/protocol-prose.cjs` (commands `agree` and `check`) is certified (P-L0-001
step 6); `script_candidate: yes` because both grammars are closed and resolve against repository state
only. The detector of copied prose between two reports (windows of normalized words,  section
8) is not built here: its window is the owner's choice by calibration data (question V-15), and until then
PROTO-DEC-0048 item 3 keeps that part a manual check.

## Purpose

Independent reports lose their independence when one copies another's prose, and they lose their
verifiability when they point at evidence that does not exist. PROTO-DEC-0048 item 3 replaced quoting by
a fixed form of agreement and asked for the exact grammar to be defined and certified like kernel code;
the specification it names never carried it (C-05 of the L7 audit). This record defines both closed forms
an author uses to lean on another text - the agreement line and the citation - and the deterministic
detector that tells, for every citation, whether it resolves, so a dangling reference cannot pass a gate
unseen.

## Rules

- R-L7-002.1. A report refers to the content of another report by a citation or by an agreement line, never by copying its prose.
- R-L7-002.2. A citation is a token of one of these closed forms: `path:line`, `path:a-b` or `path:a,b-c` with a repo-relative path and an extension of the closed list; a repo-relative path with at least one `/`; a markdown link or reference definition; a record id with or without `:line`; a rule id; a decision id `PROTO-DEC-nnnn` or `DEC-nnnn` with four digits, optionally `:k` for its item; a commit id written as 40 lower-case hex digits, or as 7 to 39 of them after `@`, alone in a code span, or after a commit word, with no condition on letters or digits; a blob id written after the word `blob`. The address after a colon is read whole, up to whitespace, a bracket, a quote, a backtick or a table mark. Only terminal sentence punctuation and closing emphasis paired with an opener are stripped; inner underscores, stars and punctuation stay part of the address. It is exactly `N`, `A-B` with A < B, or a comma list of them (for a decision item: one `K`), all from 1; any other nonempty address, or a colon look-alike before it, is a malformed citation with its text, never a shorter valid one.
- R-L7-002.3. A citation resolves only when its target exists in the repository as written: a tracked file or directory with this exact spelling, every step from the root reached without a link or junction, a file with one hard link, and the native real path equal to the path (no case fold, no short name); every cited line inside the file; a kernel record or rule (a rule of a `## Rules` section that carries text) that one record alone defines; one decision heading and its item; a git object of type commit for a commit id and of type blob for a blob id, whose full id starts with the cited one.
- R-L7-002.4. Three outcomes besides resolved are named and counted, never silent: `registered` (an open row of `.ai/core/EXTERNAL-PENDING.md` for this id and this referrer), `archived` (a path that an index row of `docs/ARCHIVE-INDEX.md` names exactly or by its directory), and `generated` (a path under `.ai/runtime/`, which AGENTS.md section 1 declares untracked output).
- R-L7-002.5. Any other citation is unresolved and is reported with its document, line, class and reason: a short form (a file name without its directory, then a line number), a `../` path, a backslash path, a malformed address, a line beyond the end, an unknown or ambiguous id, or an object of another type; a set of documents with one unresolved citation fails with exit 1.
- R-L7-002.6. A citation resolves against the current tree; a document written against an older base is not re-checked when lines drift, which is why a gate runs the detector on documents of its own candidate.
- R-L7-002.7. An agreement line is exactly `Agreement with <participant> on item <item>: <degree>.`, where the participant is one token compared without letter case, the item is one id and never a range or a list, and the degree is one of: `categorically disagree, with reasons`, `disagree`, `partially agree`, `agree with reservations`, `fully agree`, `absolutely agree, with additional confirmation found`.
- R-L7-002.8. Every degree except `fully agree` is followed on the next non-blank line, outside a fence, by `Justification: <text>` whose text carries text by the one definition of `.ai/core/schema/procedure.schema.md` section 3.1; `absolutely agree, with additional confirmation found` names in the visible text of its justification citations that all resolve or are named outcomes, and at least one of them resolves to a fact of the tree: `registered`, `archived` and `generated` never confirm.
- R-L7-002.9. A line whose statement starts with "agreement with" in any letter case, after canonical text reading (including invisible characters, entities and comments), in a list, a quote, a heading, a table cell, under emphasis or strike marks, and that does not match R-L7-002.7 exactly, is malformed and makes the check exit 2; only a closed fenced block hides a line, and where a fence's end is uncertain (an unclosed fence, the end of its quote or list item) the line is read as visible.
- R-L7-002.10. One document gives one degree per participant and item; a second line with another degree for the same pair is a conflict.
- R-L7-002.11. Agreement lines in historical reports, written before this record becomes active, are not re-checked.
- R-L7-002.12. Both checks are advisory (PROTO-DEC-0169 item 2) until an owner act on an exact candidate makes one of them blocking; the closure check of a research frame (R-L0-22.66) and the dangling-reference gate of the product build use the citation check as their mechanical part.

## Steps

1. **Write** (reviewer, certifier, critic or synthesiser). Point at evidence by citations of R-L7-002.2 and
   at another participant's points by agreement lines of R-L7-002.7. Output: the report.
2. **Check citations** (the same author). Run `node .ai/bin/protocol-prose.cjs check <report>`. Every
   `UNRESOLVED` line is fixed or the citation removed; `registered`, `archived` and `generated` counts are
   read, not hidden. Output: the `RESULT exit=0` line in the journal.
3. **Check agreements** (the same author). Run `node .ai/bin/protocol-prose.cjs agree <report>`. Exit 2 is
   a malformed line, exit 1 a missing justification, confirmation or a conflict. Output: the `RESULT` line
   in the journal.
4. **Gate use** (coordinator). A gate that needs zero dangling references runs `check` on the documents of
   its candidate and fails on exit 1 (R-L7-002.12); while the record is advisory the result is reported,
   not enforced. Output: the gate line with the counts by class.

## Interface of the detector

`node .ai/bin/protocol-prose.cjs check [--root <dir>] <path>...` - a directory means its tracked `.md` files.
Output, one line each and in this order: `UNRESOLVED at=<path>:<line> class=<class> ref=<token> reason=<text>`
per unresolved citation; `COUNT class=<class> found=<n> resolved=<n> registered=<n> archived=<n>
generated=<n> unresolved=<n>` per class; `RESULT exit=<n> files=<n> mode=<git|walk> citations=<n>
unresolved=<n>` last. Exit 0: every citation resolves or is one of the three named outcomes; 1: at least
one unresolved; 2: input outside the domain (a missing path, a path outside the root or through a link, a
file that is not a file of the repository), with `RESULT exit=2 reason=<text>`. A root that is not a git
repository is walked (mode `walk`) and a commit id then never resolves; a repository with an empty index
stays in mode `git`. Classes: `path-line`, `record-line`, `traversal`, `backslash`, `link`, `path`,
`decision`, `rule`, `record`, `commit`, `object` (a `blob <id>`).

Domain (PROTO-DEC-0169 item 3): UTF-8 Markdown written by participants; paths in Unicode letters and
digits with `/` separators; commit ids in lower-case hex. Text as data: one leading byte order mark is
dropped, CRLF line ends are read as LF, and invisible characters (Default_Ignorable_Code_Point, the set of
`.ai/bin/lib/records.cjs`) are removed before citations are read, so a citation is what a reader sees.
Out of the grammar and not citations: absolute paths (a Windows drive path, a rooted POSIX path), URLs, placeholders in angle
brackets, text between `~~` marks (a superseded value) and `sha256:` digests. Reference samples: the
fixtures of .

Exact lexical boundaries: whitespace immediately after a colon (including NBSP) means no adjacent
address; the bare path or id can still be a citation, but the following number is not checked.
Terminal `. , : ; ! ?` and fullwidth colon are sentence punctuation; the same marks inside an
address are not removed. A filename continuing beyond the closed extension, without a valid boundary,
is not a shorter filename citation. A missing generated file without an address has outcome generated;
a requested line in that missing file is unresolved. These are lexical checks, not a full Markdown renderer.
Links use the shared balanced-label/destination reader, including code spans in labels and definitions
inside quote/list containers; targets are checked as written, without renderer URL unescaping.
Each text file is decoded from a guarded read and a kernel record is parsed from those same bytes.
This is a per-file snapshot, not a transaction across the whole repository. On Windows the shared reader
may compile its native descriptor helper in temporary storage; repository-read-only is the guarantee.

## Stop conditions

Stop and go to P-L0-002 when:
- a citation cannot be written in a closed form, for example evidence outside the repository;
- an endorsement needs a degree outside the six of R-L7-002.7;
- the detector exits 2 on a document of the candidate and the cause is not the author's input.

## Back edges

None: an unresolved citation or a malformed agreement line is fixed by its author before handoff; no loop
returns to an earlier step.

## Evidence

- B - empty certification rounds and quoted prose between reports led to PROTO-DEC-0048 item 3 (fixed form of
  agreement, grammar to be certified like kernel code) and item 5 (a reproduction must resolve to a script in
  the repository). The grammar was never written into the specification it names (FACT
  , `:33`). Cost: unknown.
- Basis (not class C evidence) -  section 2 (, exit 2 for a line outside the grammar at
  `:41`),  section 8 (), the input-domain rule PROTO-DEC-0169
  item 3, the zero-dangling closure check (`.ai/core/L0-meta/P-L0-008-research-governor.md:169`) and owner
  instruction  item 5.
- B record dossier (class C is not claimed; fix round 3 answered D06 of the sealed fix-1
  certification against P-L0-001 step 3. Counts re-measured by the author with `check` on the
  tree, read-only):
  - Support marks: two independent support marks from other model families do not exist for this
    record - none were recorded, and the sealed certification rounds of this work reproduced
    objections (the fix-1 pair left the link, comment, span and record-id defects of the detector
    open at its base) instead of adding marks. The class is B: the incident evidence above carries
    the record. The metric, kill criterion and deadline below stay as the owner's trial inputs
    should class C ever be claimed with real marks; whether no objection remains is for the next
    sealed pair: unknown.
  - Expected gain: a dangling or malformed reference in a new document is reported before handoff instead
    of being found by a certifier.
  - Metric (no L6 id yet; L6 assigns one, S6-T06): unresolved citations per citation in the documents of a
    candidate written after activation. Baseline at this tree: `docs/reviews` 2391 of 10885 (22.0 %),
    `.ai/core` 134 of 3367 (4.0 %). The share of false reports among unresolved lines is unknown: no hand
    sample of this tree has been counted.
  - Kill: during the trial, a hand sample of 30 unresolved lines of new documents holds more than 6 false
    reports, or the unresolved share of new review reports is not below the `docs/reviews` baseline.
  - Deadline: the trial ends at the review of S6-T06 (validator wiring) or on 2026-11-10, whichever is first.
  - Script test (P-L0-001 step 6): the four conditions hold; signal sig-20261010-002 is open; the script is
    `.ai/bin/protocol-prose.cjs`, built in the same task (S6-T01), not yet certified.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Strict repo-relative form flags short citations in old documents | high | low | forward-only (R-L7-002.6, .11); the reason names the one file meant | rewriting a citation | historical reports keep unresolved short forms |
| A citation resolves but does not say what is claimed | medium | high | none mechanical; the reviewer opens each cited line (P-L0-001 risk table) | reviewer time | content claims stay judgement |
| The allow-lists grow into a bypass | low | high | each named outcome is an index the repository already keeps; each is counted in COUNT | none | an index row that should have been closed |
| Copied prose between reports passes | medium | medium | manual check of PROTO-DEC-0048 item 3 until the window detector is calibrated | reviewer time | copying in paraphrase |
| A bare 40-hex id names a blob (a file hash), not a commit | high in old documents | low | reported with the object type; the `blob <id>` form resolves it | rewriting the citation | 105 non-commit objects among the measured sets before the `blob` form, 81 of them bare |

## Change log

- 0.5 — 2026-10-11

- 0.1 — 2026-10-10
- 0.2 — 2026-10-10
- 0.3 — 2026-10-11
- 0.4 — 2026-10-11
- 0.6 — 2026-10-14
