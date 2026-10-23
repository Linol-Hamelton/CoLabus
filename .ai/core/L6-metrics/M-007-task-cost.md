---
id: M-007
version: 0.4
title: Full cost of a closed task - tokens, wall time, model and effort actually spent
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator]
stages: [close, accept]
triggers: [stage-exit, program-exit]
inputs: [launch-record, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-007.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-007.cjs:2, .ai/core/L2-procedures/P-L2-002-model-selection.md:130, .ai/core/L3-procedures/P-L3-002-model-discovery.md:96, PROTO-DEC-0167:4]
---

# M-007 Cost of a closed task

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The removed trials of P-L3-002 and P-L3-004 named this metric; their texts
preserve it.

## Purpose

Rank and effort choices are today made on a rubric scored by hand. The full cost of a
closed task - tokens, wall time, model and effort actually spent - is what makes the
complexity rubric and the rank choice measurable: which tiers actually cost what the rubric
predicts. CodeBurn is not installed, so the cost comes
from the recorded launch fields until the owner decides otherwise.

## Rules

- R-L6-M007.1. The metric measures the cost of a closed task from the cost fields the launch records of its closed runs carry - tokens and wall time where recorded, the model in use; a field no run records keeps its cell null (docs/ops/metrics/M-007.cjs), and the money cost stays unknown until the owner permits CodeBurn. [not mechanically enforced]
- R-L6-M007.2. A median is reported only for at least five timed runs; a smaller group gets no median, never a mean smuggled in as one (PROTO-DEC-0167 item 4).
- R-L6-M007.3. Скрипт сообщает агрегаты выбранных запусков, не отдельные ячейки стоимости каждого task. При менее пяти wallSeconds медиана null; число известных tokens.output — только заполненность, не полная стоимость. Ошибки источника дают exit 2 без JSON. [not mechanically enforced]
- R-L6-M007.4. The output is advisory: never Evidence, never a gate input; CodeBurn is not used until the owner permits it, and no cost threshold is activated by this record. [not mechanically enforced]
- R-L6-M007.5. Freshness: recomputed at each task close and at each program exit; costs from before the last landing are not read as current. [not mechanically enforced]

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-007.cjs [--a JSONL] [--b JSONL]`; the defaults are two comparable packages of closed runs. Input: launch records of closed runs. Output: the cost table, exit 0 with nulls allowed, exit 2 on an unreadable source.
2. **Read** (owner, coordinator). The cost table feeds the complexity rubric and the rank choice of model selection. Input: the table. Output: the rubric line in the journal.

## Stop conditions

Stop and go to P-L0-002 when a closed run's journal is unreadable or a verdict is missing; the run stays out, never averaged in as zero.

## Back edges

None.

## Evidence

- C - the design is the metric row M-007; the consumers are the complexity rubric and the rank choice (P-L2-002 trial text, P-L3-002 and P-L3-004 preserved trial texts).
- C - the leaf script exists (docs/ops/metrics/M-007.cjs) with the median rule and the no-CodeBurn note.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Cost is read as quality | medium | high | the record measures spend only; quality is not derived from it | none | a reader who conflates |
| Small groups get a median anyway | medium | medium | R-L6-M007.2 refuses the median under five | none | none |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-16
