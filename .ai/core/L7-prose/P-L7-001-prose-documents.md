---
id: P-L7-001
version: 0.5
title: Prose documents - kinds, headers, status, lifetime and line caps
layer: L7
type: procedure
status: active
owner_approval: PROTO-DEC-0183
decision: [PROTO-DEC-0183]
roles: [all]
stages: [any]
triggers: [draft-ready, candidate-ready, stage-exit, owner-directive]
inputs: [review-report, journal]
outputs: [review-report, journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [PROTO-DEC-0038:3, AGENTS.md:107, AGENTS.md:233, AGENTS.md:252, AGENTS.md:256]
cost_basis: unknown
---

# P-L7-001 Prose documents

Draft record. Status is draft: review, activation and any binding effect wait for
the owner's act (R-L0-17.6). It is the home of the RULE-MAP rows AR-020, AR-023, AR-039, AR-040 and AR-041.
`enforcement: none` because its script, `.ai/bin/protocol-prose.cjs`, is built in the same candidate and is
not yet certified (P-L0-001 step 6); `script_candidate: yes` because kinds, header fields, caps and the
transcription line are repository state with one answer per tree. Whether a claim is a FACT stays with
the reader.

## Purpose

Prose documents decide what the next participant believes, yet only journals had size and form rules.
Reviews over the agreed cap went unnoticed because the cap lived in prompts only (a 268-line report,
 section 1); research, specifications and program plans had no rule for header, status or
lifetime at all, and four review header styles grew side by side. This record gives each kind of prose
document one header, one status vocabulary, one lifetime and one place where its checks are named, and it
adds only the checks no lower layer already makes.

## Rules

- R-L7-001.1. A prose document of this record is one of five kinds, decided by its path alone: review report (`docs/reviews/`, a name without `prompt`), review prompt (`docs/reviews/`, a name with `prompt`), research, specification (`docs/specs/`) and program plan; a chat transcription is a form that any of them may take.
- R-L7-001.2. A document outside the five kinds is not governed here: decisions follow P-L0-005, journals P-L2-011, kernel records P-L0-001, L5 artifacts SCHEMA-artifact, and any other document keeps the class the cleanup classification computes for it until the owner names its kind.
- R-L7-001.3. A review report states in its header the reviewed commit SHA, the working tree status, the reviewer model, the date in UTC, the scope and the verdict; its verdict and mode words are those of R-L2-004.4 and R-L2-004.6.
- R-L7-001.4. A review report is immutable: a revision is a new file, and the only edit an old report may receive is a `Superseded by:` header line that names the new file by exactly one citation, a path or a markdown link, that resolves to another file of the same kind (a review report or prompt names a review report or prompt) and is not older by the date at the start of its name; a decision, record, rule or commit id is never the new file.
- R-L7-001.5. An extended analysis is saved as a report under `docs/reviews/`, the session journal links it (R-L2-011.5), and the chat carries only the verdict, the report path and the blocking findings.
- R-L7-001.6. A research document states `Date:`, `Base:` and the sentence "Advisory, not a decision" in its header, and labels its claims with the labels of R-L0-06; a Russian document may write them as ФАКТ, УТВ. and ГИП.
- R-L7-001.7. A research document lives while its frame is open and receives one disposition when the frame closes (R-L0-22.58); it is moved only by the archiver and never deleted.
- R-L7-001.8. A specification states `Author:`, `Base:` and `Status:` with one of `spec`, `implemented` or `superseded`; a change of status is a new header line and a change of text is a new version.
- R-L7-001.9. A program plan states in its header the status `предложение` (proposal) and the decision id that authorises the program, and lives until the program closes.
- R-L7-001.10. A chat transcription opens with the line `> Transcribed from chat by <who>, model: <name>, date: <ISO date>`, and like any output marked `[MODE: READ-ONLY ADVISORY]` or `Mode: ADVISORY` it never satisfies a completion gate.
- R-L7-001.11. A review prompt holds at most 150 lines and a review report at most 250 lines (PROTO-DEC-0038 item 3); a longer one is allowed only when an incident warrants it, and the check reports it as a warning, never as a block.
- R-L7-001.12. These rules bind documents written after this record becomes active; an older document is not rewritten to comply, and it gains its header when it is changed for another reason.
- R-L7-001.13. The mechanical checks of this record are the existing checks named in the section Existing checks plus `protocol-prose.cjs prose`, which adds only the caps, the headers of research, specifications and program plans, the transcription line and the `Superseded by:` target; no second parser of a check that exists is written, and the definitions it shares with the kernel (text of a value, invisible characters, record and rule ids) are imported from `.ai/bin/lib/records.cjs`, never copied.
- R-L7-001.14. The checks this record adds (`protocol-prose.cjs prose`) are advisory (PROTO-DEC-0169 item 2) until an owner act on an exact candidate makes one of them blocking; the existing checks keep the class the section Existing checks names.
- R-L7-001.15. A header field is filled only when its value carries text by the one definition of `.ai/core/schema/procedure.schema.md` section 3.1; a value that is not known is written `unknown`, and a standard no-value marker - `N/A`, `NA`, `n.a.`, `TBD`, `T.B.D.`, `none`, `null`, `undefined`, `nil`, `no`, `not known`, `not applicable`, `none recorded`, `no data`, `unknown yet` (letter case ignored, one trailing period allowed) - is not a filled value and is reported; a `Date:` is a calendar day `YYYY-MM-DD` or `unknown`; a line inside a fenced block or an HTML comment fills no field; one field written twice with two values is unknown, except a specification's `Status:`, which gains a line per change (R-L7-001.8).

## Steps

1. **Classify** (author of the document). Take the kind from the path table of R-L7-001.1. A path outside
   it: R-L7-001.2 names the record that governs it. Output: the kind.
2. **Header** (author). Write the header fields of the kind (R-L7-001.3, .6, .8, .9, .10) before the first
   `## ` heading. A field that cannot be filled truthfully is written as `unknown`, never guessed or left
   empty (R-L7-001.15). Output: the header.
3. **Check** (author). Run `node .ai/bin/protocol-prose.cjs prose <path>` for caps and headers and
   `node .ai/bin/protocol-prose.cjs check <path>` for citations (P-L7-002); for a review report also the
   existing header check of the report gate. Each problem line is fixed or named in the
   journal with its reason. Output: the RESULT lines in the journal.
4. **Publish** (author). Link the document from the session journal (R-L2-011.5). Output: the journal line.
5. **Revise** (author). A review report: a new file, then the `Superseded by:` line in the old one
   (R-L7-001.4). A specification: a new header status line or a new version (R-L7-001.8). Output: the new
   file or line.
6. **Retire** (coordinator). When a research frame closes, P-L0-008 assigns the disposition; when a program
   closes, its plan is archived by the archiver with an index row. Output: the disposition or index row.

## Existing checks

What already runs and is referenced, not repeated (code anchors are text, not line offsets):

| Check | Where | What it covers | Class |
|---|---|---|---|
| CM-24 line limits | `.ai/bin/validator/text.cjs` (`CM-24`) | `.ai/TASK.md` 80, `.ai/PLAN.md` 1000, each journal 150 | FAIL |
| CM-22 journal count | `.ai/bin/validator/text.cjs` (`CM-22`) | at most 300 journals | WARN |
| CM-23 review corpus | `.ai/bin/validator/text.cjs` (`CM-23`) | active `docs/reviews/` 400 files or 8 MB, source role | WARN |
| CM-45 journal owner | `.ai/bin/validator/text.cjs` (`CM-45`) | an entry naming another agent | WARN |
| Completion-gate review | `.ai/bin/validator/gate-structure.cjs` (`Receipt-Owner`) | Mode, Reviewer, Verdict, Receipt-Owner of reviews named in a Completion gate | FAIL |
| Advisory and transcription markers | `.ai/bin/validator/gate-structure.cjs` (`ADVISORY`) | `[MODE: ... ADVISORY]` and the transcription phrase detected | FAIL on a gate |
| Review header, eight fields | the report gate (`REQUIRED_HEADER_FIELDS`) | SHA, tree, reviewer, date, mode, receipt owner, scope, verdict | advisory |
| Generated prompt cap | the prompt generator (`MAX_LINES`) | a generated prompt over 150 lines is refused | generator only |
| Journal archive | `.ai/bin/protocol-archive.cjs` (`autoArchiveWorklog`) | a journal over 150 lines is archived on stop and record | action |
| Five labels | `.ai/bin/protocol-hooks.cjs` (`REQUIRED_LABELS`) | a journal entry without Agent, Action, Result, Next step, Open | Stop hook |

## Stop conditions

Stop and go to P-L0-002 when:
- a document fits no kind and no record of R-L7-001.2;
- a header field can only be filled by a guess (for example a reviewed SHA nobody recorded);
- a document must exceed its cap and no incident is named;
- a revision would change the content of an existing review report.

## Back edges

None: a document that fails a check is fixed by its author in step 3 or the problem is named in the
journal; no loop returns to an earlier step.

## Evidence

- B - the cap lived only in prompts and was broken: a 268-line report
  against the 250-line cap of PROTO-DEC-0038 item 3 (`AGENTS.md:107`); no validator check of it existed.
  Cost: unknown.
- B - four review header styles and two label vocabularies; review rules carried in `AGENTS.md:233`, `:252`, `:256`
  without a kernel home (AR-039..AR-041).
- Basis (not class C evidence) - the owner's instruction to home L7-L9 and the kinds table of the design, and
  the interface audit of the lower layers.
- B record dossier (class C is not claimed; counts measured with `prose` on the tree, read-only):
  - Support marks: two independent support marks from other model families do not exist for this
    record - none were recorded, and the sealed certification rounds of this work reproduced
    objections (the first fix left the header and citation defects of `prose` open at its base)
    instead of adding marks. The class is B: the incident evidence above carries the record. The
    metric, kill criterion and deadline below stay as the owner's trial inputs should class C ever
    be claimed with real marks; whether no objection remains is for the next sealed pair: unknown.
  - Expected gain: a review over its cap, a research document without its advisory header and a header
    field left empty are named when written, not found later.
  - Metric (no L6 id yet; L6 assigns one): `prose` problems per checked document among documents
    written after activation. Baseline at this tree: `docs/reviews` 9 problems in 351 files (all caps),
     1071 in 373, `docs/specs` 10 in 4, program plans 0 in 7.
  - Kill: during the trial, more than 1 in 5 reported problems in new documents is judged false by a
    reviewer who is not the author, or new research documents show no fewer problems per document than the
    baseline.
  - Deadline: the trial ends at the review of the validator wiring or on 2026-11-10, whichever is first.
  - Script test (P-L0-001 step 6): the four conditions hold; the signal is open; the script is
    `.ai/bin/protocol-prose.cjs`, built in the same task, not yet certified.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A sixth kind appears and is left unchecked | medium | medium | R-L7-001.2 names the governing record; a new kind enters only through P-L0-001 | one change of this record | a document the owner never classifies |
| Header checks turn into ceremony | medium | low | advisory only (R-L7-001.14); forward-only (R-L7-001.12) | one command per document | warnings that nobody reads |
| A second header parser drifts from the first | low | medium | R-L7-001.13: review headers stay with report-gate and the completion gate | none | the two existing parsers differ on aliases |
| Caps cut a needed report | low | medium | warning, not block; incident exception (R-L7-001.11) | none | — |

## Change log

- 0.4 — 2026-10-11

- 0.1 — 2026-10-10
- 0.2 — 2026-10-10
- 0.3 — 2026-10-11
- 0.5 — 2026-10-14
