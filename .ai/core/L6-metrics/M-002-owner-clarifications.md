---
id: M-002
version: 0.3
title: Owner clarifications per stop-question; open questions and owner-words freshness
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator]
stages: [session, close]
triggers: [stop-question, session-end]
inputs: [owner-card, stop-question, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-002.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-002.cjs:2, .ai/core/L0-meta/P-L0-002-stop-and-ask.md:95, .ai/core/L0-meta/P-L0-009-authorised-action.md:76]
---

# M-002 Owner clarifications per stop-question

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The trial of P-L0-002 and the trial of P-L0-009 both name this metric.

## Purpose

A stop-question costs the owner's attention. If one stop-question needs many
clarifications, or the same question keeps returning, the stop form of P-L0-002 is failing
and the kernel is thinner than the work needs. This metric counts clarifications per
stop-question, the open questions in the task file, and the freshness of the owner's
recorded words, so the owner-card decision has a number.

## Rules

- R-L6-M002.1. Определение  section 6, row M-002 требует уточнений владельца на stop-question; скрипт эвристически считает заголовки вопросов в карточках. Связи с ответами владельца нет, value=null; открытые вопросы TASK и дата приложения этим листом не измеряются. [test:  :: M-002 counts Вопрос headings outside fences only]
- R-L6-M002.2. A file counts as an owner card only by the closed name grammar of the card form; councils, tasks and tables are not cards (docs/ops/metrics/M-002.cjs). [not mechanically enforced]
- R-L6-M002.3. Нечитаемая или недекодируемая карточка даёт exit 2 без JSON; отсутствие связи с ответом оставляет итоговую долю null, не ноль уточнений. [not mechanically enforced]
- R-L6-M002.4. The output is advisory: never Evidence, never a gate input; the card form (one question, variants, default, SHA and branch, at most three questions per card) stays the acting rule, and no numeric threshold for this metric is activated by this record. [not mechanically enforced]
- R-L6-M002.5. Freshness: the addendum date is checked before each card and before each decision that leans on the numbers; a derived owner-words journal is never written before its primary source. [not mechanically enforced]

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-002.cjs [--a DIR] [--b DIR]`; the defaults are the two comparable card windows. Input: owner cards. Output: clarifications per card, exit 0 with nulls allowed, exit 2 on an unreadable source.
2. **Read** (owner, coordinator). Before the next card: is the last addendum fresh, is the question already answered. Input: the numbers. Output: the card or its absence.

## Stop conditions

Stop and go to P-L0-002 when the card corpus is unreadable or an addendum cannot be verified; the metric stays unknown.

## Back edges

None.

## Evidence

- C - the design is  section 6 row M-002; P-L0-002 and P-L0-009 name it as their trial metric.
- C - the leaf script exists (docs/ops/metrics/M-002.cjs) with the closed card-name grammar.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A non-card file inflates the count | medium | medium | R-L6-M002.2 closed name grammar | none | a card-shaped note outside the form |
| The metric is read as a quota on asking | medium | high | R-L6-M002.4 keeps every threshold a proposal | none | an owner flooded by unasked questions |

## Change log

- 0.1 — 2026-10-14

- 0.2 — 2026-10-15
- 0.3 — 2026-10-16
