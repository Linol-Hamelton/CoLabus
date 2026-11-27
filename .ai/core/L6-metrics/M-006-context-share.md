---
id: M-006
version: 0.3
title: Share of instruction context against work - packet bytes against bytes read
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute]
triggers: [dispatch, budget-exhausted]
inputs: [launch-record, environment-manifest]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-006.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-006.cjs:2, .ai/core/L0-meta/P-L0-007-comparative-test.md:69]
---

# M-006 Context share against work

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act.

## Purpose

A packet is overhead until work starts. If instruction bytes dominate what the seat
actually read and used, the layer budgets are wrong or the packet profile is too heavy.
This metric measures the share of instruction context against work, so the layer budgets
and the profile levels are calibrated on measured bytes, not on feel.

## Rules

- R-L6-M006.1. Определение M-006 требует packet bytes / bytes actually read; нынешний скрипт сообщает лишь заполненность полей launch-record. Это эвристика доступных полей, не измерение прочитанного контекста: value=null. [not mechanically enforced]
- R-L6-M006.2. Bytes actually read by a seat are not recorded today; the share therefore stays null, and the packet and prompt byte fills are measured and reported as fills, never as the share (docs/ops/metrics/M-006.cjs).
- R-L6-M006.3. Unknown is never a number: a launch without packet fields keeps its cell null; a missing denominator never yields zero. [not mechanically enforced]
- R-L6-M006.4. The output is advisory: never Evidence, never a gate input; any fill threshold (for example eighty percent of mandatory fields before decision metrics) is a proposal, never a gate. [not mechanically enforced]
- R-L6-M006.5. Freshness: recomputed at each dispatch review and after each layer landing, compared before and after; a number from before the last landing is not read as current. [not mechanically enforced]

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-006.cjs [--a JSONL] [--b JSONL]`; the defaults are the two launch journals. Input: launch records. Output: the fill table with a null share, exit 0 with nulls allowed, exit 2 on an unreadable source.
2. **Read** (coordinator). The packet-byte fills feed the layer budget and profile decisions. Input: the table. Output: the budget line in the journal.

## Stop conditions

Stop and go to P-L0-002 when a launch journal is unreadable; the metric stays unknown for that corpus, and no share is inferred from fills alone.

## Back edges

None.

## Evidence

- C - the design is the metric row M-006; the consumers are the layer budgets and the profile rows of the L6 table.
- C - the leaf script exists (docs/ops/metrics/M-006.cjs) and states the not-recorded share in its header.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A fill is read as the share | high | high | R-L6-M006.2 keeps the share null until bytes read are recorded | none | a reader who wants a number |
| Packet fields stay unfilled | high | medium | the fill count makes the gap visible | none | zero measured launches |

## Change log

- 0.1 — 2026-10-14

- 0.2 — 2026-10-15
- 0.3 — 2026-10-16
