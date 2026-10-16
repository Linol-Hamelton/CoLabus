---
id: M-001
version: 0.8
title: LCC defects caught by the author against those found by the reviewer, by layer
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [procedure-author, reviewer, coordinator]
stages: [accept, close]
triggers: [review-finding, stage-enter:accept]
inputs: [review-report, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-001.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-001.cjs:2, .ai/core/L0-meta/P-L0-001-procedure-lifecycle.md:159, PROTO-DEC-0047:11]
---

# M-001 LCC defects: author against reviewer

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The trial of P-L0-001 names this metric; until now it was counted by hand.

## Purpose

The procedure lifecycle P-L0-001 is kept alive by its trial only if the author's own LCC
hunt catches defects before review does. If review finds what the author's hunt missed,
round after round, the procedure is not working. This metric measures that difference per
layer, so the keep-or-improve decision of P-L0-006 has a number instead of an impression.

## Rules

- R-L6-M001.1. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Value=null: нет per-defect provenance; join не восстанавливается эвристикой. ( section 6, row M-001). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts]
- R-L6-M001.2. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Разбиение по дате не скрывает malformed review. ( section 6, row M-001). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts]
- R-L6-M001.3. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Четыре totals суммируются в walkCount, not-a-review и excluded именуются с правилом. ( section 6, row M-001). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts]
- R-L6-M001.4. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Advisory, не Evidence и не gate input; запрет использования вручную, [not mechanically enforced]. ( section 6, row M-001). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts]
- R-L6-M001.5. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Freshness проверяет оператор, [not mechanically enforced]. ( section 6, row M-001). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts]

## Steps

1. **Run** (reviewer or coordinator). `node docs/ops/metrics/M-001.cjs [--a DIR] [--b DIR]`; the defaults are the two comparable review windows. Input: review reports. Output: exit 0 с компактным отказом при ошибке источника; exit 2 при ошибке аргументов или author-report path escape.
2. **Read** (coordinator). The per-layer cells feed the trial review of P-L0-001 and the improve-or-retire decision of P-L0-006. Input: the table. Output: the decision line in the journal.

## Stop conditions

Stop and go to P-L0-002 when the source directory is unreadable or a report cannot be decoded; the metric then stays unknown and is never guessed.

## Back edges

None.

## Evidence

- C - the design of the metric is  section 6 row M-001 (`.ai/core/L0-meta/P-L0-001-procedure-lifecycle.md:159` names it as the trial metric of the lifecycle, counted by hand until L6 defines it).
- C - the leaf script exists (docs/ops/metrics/M-001.cjs) and carries the unknown-never-a-number rule in its header.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Provenance is guessed to fill a cell | medium | high | R-L6-M001.2 keeps the cell null | none | an unrecorded defect |
| The number becomes a target | medium | medium | R-L6-M001.4 keeps it out of every gate | none | a reader who turns it into a quota |

## Change log

- 0.1 — 2026-10-14

- 0.2 — 2026-10-15

- 0.3 — 2026-10-15

- 0.6 — 2026-10-15

- 0.7 — 2026-10-15
- 0.8 — 2026-10-16
