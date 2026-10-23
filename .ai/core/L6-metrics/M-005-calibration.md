---
id: M-005
version: 0.8
title: Certifier calibration - verdict against final outcome, in the slot and in the shadow
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator, certifier, shadow-certifier]
stages: [accept, freeze]
triggers: [verdict:FAIL, package-freeze]
inputs: [review-report, findings-ledger, launch-record]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-005.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-005.cjs:2, .ai/core/L1-roles/ROLE-shadow-certifier.md:36, PROTO-DEC-0047:4]
---

# M-005 Certifier calibration

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act.

## Purpose

Shadow seats are admitted to real slots on one argument: their verdicts agree with the
final outcome often enough. This metric scores each certifier's verdicts against the final
outcome, and the shadow's verdicts the same way, so the pair selection and the shadow
admission are decisions about numbers, not about names.

## Rules

- R-L6-M005.1. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Value=null/final-outcome-unrecorded и calibrationMatrix=null: outcome join отсутствует.
- R-L6-M005.2. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Счёт verdict token по agent не ранжирует transports.
- R-L6-M005.3. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Четыре totals точно покрывают walkCount.
- R-L6-M005.4. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Admission/shadow admission вручную; [not mechanically enforced].
- R-L6-M005.5. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; только {value:null, reason, firstOffendingLine, offendingLines}; без counts, denominator и lists. Freshness вручную, [not mechanically enforced].

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-005.cjs [--a DIR] [--b DIR]`; the defaults are the two comparable review windows. Input: review reports and outcomes. Output: exit 0 с компактным отказом при ошибке источника; exit 2 при ошибке аргументов.
2. **Read** (owner). Before naming a pair or admitting a shadow: does the cell have enough verdicts, does the score differ from the slot's. Input: the table. Output: the pair or admission decision in the journal.

## Stop conditions

Stop and go to P-L0-002 when the outcome of a scored package is unknown; the cell stays null and no ranking is inferred from an empty denominator.

## Back edges

None.

## Evidence

- C - the design is the metric row M-005; the consumer is the pair and shadow decision (PROTO-DEC-0047 item 4).
- C - the leaf script exists (docs/ops/metrics/M-005.cjs) with the verdict reader of the shared library.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| An empty cell is read as a bad score | medium | high | R-L6-M005.3 keeps it null | none | a small-corpus seat |
| The proposal thresholds are read as active | medium | high | R-L6-M005.4 names the acting rule | none | a reader who skips the rule |

## Change log

- 0.1 — 2026-10-14

- 0.2 — 2026-10-15

- 0.3 — 2026-10-15

- 0.6 — 2026-10-15

- 0.7 — 2026-10-15
- 0.8 — 2026-10-16
