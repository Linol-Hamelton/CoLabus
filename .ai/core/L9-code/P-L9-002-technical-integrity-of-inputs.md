---
id: P-L9-002
version: 0.3
title: Technical integrity of inputs - one canonical form, refuse or unknown for everything else
layer: L9
type: procedure
status: draft
roles: [implementer, reviewer, certifier, fixer]
stages: [execute, accept]
triggers: [owner-directive, signal:defect-found, incident]
inputs: [task-frame, journal]
outputs: [journal, evidence]
back_edges: []
enforcement: S~
enforced_by: [.ai/bin/lib/hostile-corpus.cjs]
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0038, PROTO-DEC-0190, .ai/bin/lib/text-safe.cjs:1, .ai/bin/lib/path-safe.cjs:1, .ai/bin/lib/verdict-read.cjs:1, tools/operator/closed-number.cjs:47]
cost_basis: unknown
---

# P-L9-002 Technical integrity of inputs

Draft 0.1 through P-L0-001 (owner word  item 3, 2026-10-15; fix round 1 under
PROTO-DEC-0190). Advisory until the owner approves it: the compiler never includes a draft, and
it becomes binding only by a later owner act. The rules below state the contract; `enforcement:
S~` covers the hostile corpus and its tests only - whether a given reader declares its canonical
form honestly stays judgement.

## Purpose

Most failures of the days before 2026-10-15 were not about meaning or logic but about technical
details: invisible or look-alike characters, encodings, BOM and CRLF, placeholders, broken
Markdown containers, silent drops of rows or files, links and paths (owner word: 
item 3, ). The recurring shape:
a reader checks "a value is there" and enumerates bad forms instead of requiring ONE canonical
form and refusing everything else. This record gives that contract one home in the code layer,
next to P-L9-001.

## Rules

- R-L9-002.1. Every reader of human-written or external text declares ONE canonical form for each source it reads and the scope the declaration covers, and a source without a declared canonical form is not read (not mechanically enforced: the declaration is prose in the reader's header; no test checks prose, the corpus tests below exercise the behavior only).
- R-L9-002.2. Inside the declared scope, any non-canonical input makes the result unknown or a refusal that names its reason, never a number, a pass or a silent skip (not mechanically enforced for readers in general: nothing in the tree proves the sentence for a reader the corpus has not been run against; what IS proven is the instrument -  proves the adoption helper `acceptedBy` lists every variant a reader accepts inside a declared scope and refuses a scope that judges nothing (EMPTY_SCOPE), and  applies it to two real readers, pinning their violations as REPORTED findings rather than proving the rule for them).
- R-L9-002.3. Only the shared kernel readers decode text: text-safe decode with the invisible/BOM/CRLF policy and unique-key JSON, maskMarkdown with unclosed-container detection, path-safe real-path containment; no private copy of a decoder (not mechanically enforced: nothing in the tree checks for a private decoder copy;  covers the shared readers themselves, and a gap found in them is reported to the operator, never patched privately).
- R-L9-002.4. Identities and values follow closed grammars and placeholders never match: -, TBD, n/a, unknown, ?, the empty string and whitespace are values a canonical grammar refuses (enforcing test for the corpus side:  proves a placeholder variant is never the canonical sample and that a placeholder equal to the sample is dropped as a named marker, never a fake attack; for the reader side,  proves a closed id-cell grammar refuses homoglyph and invisible prefixes and pins REPORTED F-B4 - the process register accepts placeholder cells today, a violation of this rule by a landed reader, not a proof that the rule holds everywhere).
- R-L9-002.5. Every new reader, and every reader whose scope changes, ships with tests generated from the shared hostile corpus `.ai/bin/lib/hostile-corpus.cjs` for each of its canonical samples (not mechanically enforced: nothing in the tree checks that a given reader ships corpus tests; what IS proven is the corpus itself -  and ; R-L9-002.6 makes running them a certifier step).
- R-L9-002.6. A certifier of a package that adds or changes a reader of human-written or external text runs the shared hostile corpus of this record against the reader's canonical samples and records every variant silently accepted as canonical as a finding (not mechanically enforced: the per-package run is manual; the helper and its grammar are proven by , its mutation suite by , and two real-reader applications by ).
- R-L9-002.7. The corpus contract for the Markdown container kinds is a CLOSED ALLOW-LIST, never an emulation of CommonMark container semantics: the container kinds (fence, unclosed fence, HTML block, details, comment, quote, indented code, list item, setext underline, lazy continuation, second table) are produced ONLY for a plain sample - every line inside the closed allow-list (ASCII letters, digits, the space, and the punctuation characters . , : ; / ( ) ' -), no line starting with a character that can begin a Markdown block, no blank line - decided by the ONE function `isPlainSample` of `.ai/bin/lib/hostile-corpus.cjs`; for any other sample every container kind yields its named not-applicable entry with the reason `sample-not-plain`. The corpus does not model what the allow-list does not name: a lenient emulation never terminates (each earlier repair found another container rule the emulation did not model), so a sample outside the allow-list is a named refusal, never a fabricated wrap that could leak the sample's later lines as the document's own text and never a false marker (enforcing tests:  proves the eleven named markers for the codex F1-F3 reproductions and every refusal shape, that a plain sample produces every container kind with no marker, the generated-count and one-difference proofs on the plain shapes, and that the honest mask-following reader receives no container at all for a non-plain sample;  kills the dropped character, blank-line and block-start checks, the over-refusing inversion, the shrunk and wrongly widened allow-list, the block-start set without the bullet, the wrong marker reason, the incomplete marker list and the marker that carries the sample as text).

## Steps

1. **Declare** (implementer). For each source the reader reads, write the canonical form and the scope in the reader's header comment. Input: the source. Output: the declaration.
2. **Route through the shared readers** (implementer). Decode with text-safe, mask with maskMarkdown, judge paths with path-safe; write no private decoder. Input: bytes. Output: decoded text or a refusal.
3. **Refuse or unknown, with a reason** (implementer). A non-canonical input yields unknown or a refusal naming the reason; a counter stays null, never 0. Input: decoded text. Output: the result or the refusal.
4. **Corpus tests** (implementer). Generate the variants of each canonical sample with the hostile corpus and assert, through `acceptedBy`, that the reader refuses or unknowns every variant in its declared scope; pin every accepted variant as a REPORTED finding. Input: canonical samples. Output: the test.
5. **Certification** (certifier). Run the reader's corpus tests and hunt with kinds outside them (R-L9-002.6). Input: the candidate. Output: findings.

## Stop conditions

Stop and go to P-L0-002 when:

- a source has no decidable canonical form (the owner names it);
- a reader must accept a non-canonical form for a real consumer (the owner decides the exception and it is written into the declaration);
- a shared kernel reader lacks a policy the reader needs (the gap is recorded for the owner; no private copy is written).

## Back edges

None.

## Evidence

- A - real defects with reproductions, archived certifier reports: a whitespace or U+200B receipt counted as a receipt id and duplicate JSON keys accepted, and an invisible closure_commit anchoring a row (l56c3, opus, lines 23 and 25); the shared invisible-list gap - the Hangul fillers U+3164/U+115F and the braille blank U+2800 unclassified, a lone surrogate re-encoded to U+FFFD and left readable (l56c3, opus, line 26); a register read silently passing a corrupted file hidden behind the shared mask (archived certifier report). Cost: unknown in attempts.
- B - the shared readers that already implement the contract (.ai/bin/lib/text-safe.cjs, path-safe.cjs, verdict-read.cjs) and the hostile corpus with its conformance and mutation suites. Cost: unknown.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Read as binding before the owner act | medium | high | status draft; the compiler never includes a draft | none | a reader who skips the status |
| Corpus variants are treated as the complete attack list | medium | high | R-L9-002.5 makes certifiers hunt beyond them | certifier time | new hostile forms appear faster than the corpus |
| Readers of other packages are fixed in passing | medium | medium | REPORTED-only findings; fixes need their own round | none | an eager fixer |
| The declaration drifts from the code | medium | medium | corpus tests pin behavior, not prose | test time | an untested scope edge |

## Change log

- 0.1 — 2026-10-15
- 0.2 — 2026-10-15
- 0.3 — 2026-10-15
