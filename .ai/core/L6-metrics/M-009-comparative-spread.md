---
id: M-009
version: 0.4
title: Spread of repeated runs of one variant against the difference between variants
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [reviewer, procedure-author, coordinator]
stages: [accept, research]
triggers: [stage-enter:accept, research-consensus]
inputs: [launch-record, review-report, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-009.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-009.cjs:2, .ai/core/L0-meta/P-L0-007-comparative-test.md:94, PROTO-DEC-0167:4]
---

# M-009 Comparative spread against variant difference

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The trial of P-L0-007 names this metric as its kill measure.

## Purpose

A comparative test says variant A beat variant B. If repeating the same variant varies as
much as the variants differ, the result was noise. This metric compares the spread of
repeated runs of one variant against the difference between variants on the same task and
model, so a keep-or-retire decision (R-L0-21) never leans on an indistinguishable result.

## Rules

- R-L6-M009.1. The metric measures the spread of repeated runs of one variant against the difference between variants of the same task and model ( section 6, row M-009; the kill criterion of the P-L0-007 trial). [not mechanically enforced]
- R-L6-M009.2. Медиана требует пяти значений; range группы сообщается с n уже при двух повторах. Нулевой range допустим при равных измеренных временах, но не означает победу. При нехватке повторов агрегаты и distinguishable=null (PROTO-DEC-0167 item 4; docs/ops/metrics/M-009.cjs). [not mechanically enforced]
- R-L6-M009.3. Unknown is never a number: a variant without repeats stays null; an indistinguishable result is reported as indistinguishable, never as a win of the newer variant. [test:  :: M-009 thin repeat cells keep distinguishable null (never false-by-default)]
- R-L6-M009.4. The output is advisory: never Evidence, never a gate input; it feeds the trial review of P-L0-007 and the comparative judgement of R-L0-21, and activates no threshold of its own. [not mechanically enforced]
- R-L6-M009.5. Freshness: recomputed for each comparative test report before its trial review; numbers from an earlier corpus are not read as current. [not mechanically enforced]

## Steps

1. **Run** (reviewer or coordinator). `node docs/ops/metrics/M-009.cjs [--a JSONL] [--b JSONL]`; the defaults read the comparative journal once and split it into within-variant repeat groups and between-variant pairs. Input: launch records of comparative runs. Output: the spread table, exit 0 with nulls allowed, exit 2 on an unreadable source.
2. **Read** (reviewer). At the trial review: is the variant difference larger than the repeat spread; if not, the result is indistinguishable. Input: the table. Output: the trial line in the journal.

## Stop conditions

Stop and go to P-L0-002 when the comparative corpus is unreadable or a claimed pair has no repeats; the comparison stays unknown.

## Back edges

None.

## Evidence

- C - the design is  section 6 row M-009; P-L0-007 names it as the trial metric that measures its kill criterion.
- C - the leaf script exists (docs/ops/metrics/M-009.cjs) with the median rule of PROTO-DEC-0167 item 4.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A noise result is read as a win | medium | high | R-L6-M009.1 compares spread against difference | none | a reader who wants a verdict |
| A range below five runs is read as a verdict of noise | medium | medium | R-L6-M009.2 reports the range with its run count and refuses the median under five | none | a reader who skips the run count |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-16
