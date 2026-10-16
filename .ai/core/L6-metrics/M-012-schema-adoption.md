---
id: M-012
version: 0.4
title: Adoption rate of the stage-4 schemas by packages (defined here; trial metric of three schemas)
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [procedure-author, reviewer, coordinator]
stages: [accept, freeze]
triggers: [record-change, package-freeze, stage-enter:accept]
inputs: [task-frame, environment-manifest, record-draft, CATALOG]
outputs: [journal]
back_edges: []
enforcement: P
script_candidate: yes
evidence_class: [C]
evidence: [.ai/core/EXTERNAL-PENDING.md:32, .ai/core/schema/scenario.schema.md:65, .ai/core/schema/task-frame.schema.md:105, .ai/core/schema/environment-manifest.schema.md:83, PROTO-DEC-0047:11]
---

# M-012 Schema adoption by packages

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The three stage-4 schemas cite this metric as the trial measure of their class C
records, and no other definition of it exists in the corpus (checked: the 
section 6 table carries M-001..M-011 only; the three schema Evidence sections carry the
same one-line pointer). This record therefore states that gap and proposes the minimal
definition; the owner decides whether to accept it (Q-L5L6-3 of the design doc).

## Purpose

A schema is kept alive by adoption, not by existing. The scenario, task-frame and
environment-manifest schemas were landed on a predicted gain (class C): packages would
produce their artifacts in the schema's shape. If package after package ignores a schema,
the schema is a tax and its trial must kill it. This metric measures adoption, so the
trial reviews of the three schemas and the improve-or-retire decision of P-L0-006 have a
number.

## Rules

- R-L6-M012.1. Nothing before this record defined M-012 beyond the one-line forward reference of the three schemas ("adoption rate by stage-4 packages"); this record proposes the minimal definition, and the proposal becomes the definition only by the owner act that activates this record. [not mechanically enforced]
- R-L6-M012.2. Proposed definition: for a schema S and a package P produced after stage 4, P adopts S when the artifact of P that S governs validates against S (the frame lint or record lint of the governing schema exits 0); the adoption rate of S is the count of adopting packages over the count of packages obliged to use S in the window. [not mechanically enforced]
- R-L6-M012.3. A package obliged to use S whose artifact is missing counts in the denominator and not in the numerator; a window with no obliged packages has no rate (null), never zero; unknown is never a number. [not mechanically enforced]
- R-L6-M012.4. The output is advisory: never Evidence, never a gate input; the kill condition of each schema's trial stays the acting rule, and any threshold (a proposal only: adoption below one half of obliged packages in two consecutive stages is a kill candidate) is never a gate. [not mechanically enforced]
- R-L6-M012.5. Freshness: recomputed at each package freeze and each stage exit, before the trial review of the citing schema; rates from an earlier window are not current. [not mechanically enforced]

## Steps

1. **Collect** (procedure-author or reviewer). Today no script computes this metric (`enforcement: P`): the adopting and obliged packages are collected by hand from the catalog and the package freeze records, and the artifacts are checked with the frame and record lint. Input: packages and their artifacts. Output: the two counts per schema.
2. **Compute and read** (reviewer). Rate = adopting over obliged, by schema and window; at the trial review of a citing schema, compare the rate against that schema's kill condition. Input: the counts. Output: the trial line in the journal.
3. **Automate later** (procedure-author). The two counts are repository state and a fixed rule, so the metric is a script candidate; a leaf is added only through the lifecycle, never by using it first.

## Stop conditions

Stop and go to P-L0-002 when the set of obliged packages for a schema cannot be named from the freeze records; the rate for that schema stays null.

## Back edges

None.

## Evidence

- C - the three citing schemas name this metric as their trial measure with the same one-line pointer, and no further definition exists in the corpus: `.ai/core/schema/scenario.schema.md:65`, `task-frame.schema.md:105`, `environment-manifest.schema.md:83` (their change logs declare the forward reference, ADV-010 P4-2/P4-4).
- C - the keep-or-drop rule for a metric without a consumer is PROTO-DEC-0047 item 11; this metric's consumers are the three trials and P-L0-006.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The proposed definition is read as accepted | medium | high | R-L6-M012.1 keeps it a proposal until the owner act | none | a reader who skips the rule |
| Hand counting drifts | high | medium | the counts name their package and window; a script candidate is recorded (step 3) | none | until automated |
| An unmeasured schema reads as adopted | medium | medium | R-L6-M012.3 keeps the rate null without obliged packages | none | none |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-16
