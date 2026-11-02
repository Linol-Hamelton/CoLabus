---
id: M-004
version: 0.9
title: Escapes - defects found after a PASS, per certified package
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator, certifier]
stages: [accept, freeze]
triggers: [review-finding, verdict:FAIL]
inputs: [review-report, findings-ledger]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-004.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-004.cjs:2, PROTO-DEC-0047:4]
---

# M-004 Escapes after a PASS

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act.

## Purpose

A defect found after a PASS means a certification seat let a real defect through. Counting
escapes per certifier, against the outcome, calibrates the seats: who is due a recheck,
whose verdicts carry weight, and when the pair order must change. Without the count, a
repeatedly escaped seat keeps certifying.

## Rules

- R-L6-M004.1. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. value = escapeCandidates / packagesPassed: позже датированный FAIL после PASS одного slug — кандидат, без reproduction не доказанный escape.
- R-L6-M004.2. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Unknown другого slug обнуляет share; root-cause join не вычисляется.
- R-L6-M004.3. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. При отсутствии PASS value=null/no-pass или no-records.
- R-L6-M004.4. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Порог и certifier calibration не активируются; [not mechanically enforced].
- R-L6-M004.5. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Freshness вручную, [not mechanically enforced].

## Strict execution rules

K1 определяет enforcing. Проверка запускает каждый названный
файл через node --test с точным набором имён и JSON machine reporter. Только один
top-level test:pass, exit 0, без skip/todo считается исполненным. Статический
прямой assert/assert.* до return/throw остаётся вторым независимым условием.
Распознавания вариантов вызова skip/todo больше нет. Пустой callback, assertion
только внутри ветки/цикла, отсутствующий/дублированный тест не дают enforcement.
Runtime options с вычисляемым skip:false допустимы. Timeout/ошибка reporter дают
отказ; результат кешируется только в процессе по исходнику, пути и набору имён.
Это не доказывает корректность произвольной подмены assert или внешнего helper.
Одна проверка читает текст records; независимые проверки смотрят runtime coverage, чтобы
названная enforcing-проверка не запускала саму себя через coverage рекурсивно.

K2: действует закрытая грамматика каждого столбца, а не перечень видов
Markdown. Frame ID и Stream: [A-Z0-9-]+ плюс существующие точные field contracts.
Path: '-' или docs/[A-Za-z0-9./-]+, без backticks. Остальные cells: ASCII letters,
digits, space и . , : ; / ( ) ' -; точка/двоеточие завершают token (далее space
или конец), поэтому URL/autolink не проходит. Counter: точное имя из COUNTERS,
в том числе DIG_FLOOR и DEFERRED_ACCEPTED. Headers/delimiters имеют отдельный
фиксированный формат. Любой другой символ даёт отказ, включая одиночные tilde,
underscore, backslash и non-ASCII; нет Unicode normalisation или markup-kind gate.

K3: отвергнутый пакет M-003/M-004/M-010/M-011 содержит ТОЛЬКО
{value:null, reason, firstOffendingLine, offendingLines}. Последний массив содержит
не более 20 уникальных положительных физических адресов, первый адрес либо null.
Никаких счётчиков, lists, denominator, bytes, sha256, records или unknowns внутри
такого пакета. CLI sources тоже содержит этот отказ; верхний unknowns имеет лишь
причину, без чисел в пояснениях. У принятого пакета обычные измерения сохранены.

K4: числа различий нет. M-010 Frames сообщает ТОЛЬКО первую
физическую строку отказа и offendingLines из одного адреса. Полного счётчика
различий нет; адрес не выходит за EOF. JSONL сохраняет до 20 адресов, без count.
Внутренний parser diagnostic не является опубликованным измерением.

K5: ошибки чтения, decode, parse, render и вычисления пакета локализованы и дают
source-unreadable/source-undecodable/source-exception либо non-canonical-input.
Когда физическая строка известна, она сохраняется. BOM посреди строки и lone CR
дают отказ, не исключение из leaf. CLI при отказе источника выдаёт JSON и exit 0;
exit 2 означает ошибку аргументов. Отдельные A/B сохраняют независимость источников.

K6: именованный тест проверяет heading без финального LF и уникальность внутренних
unknownUnits для одной повреждённой строки. Обе мутации этой проверки убиты.
Удаление de-dup guard было эквивалентно для публичного Set, но изменяет raw
diagnostic; тест проверяет именно этот существующий внутренний контракт.

Сохранены общий fieldIssues после round trip до slice, исходные байты scope edges
и commit locator [a-f0-9]{1,40} без trim. Тесты сохраняют полный
корпус отказов и число проверенных cases; числа source offences они не обещают.
Прежние проверки сохранены с публикацией по K3/K4. Assertions о parser-level counters,
receipt/frame/commit и конфликте остаются отдельно от проверки compact refusal.
FRAMES.md, CLOSURES.jsonl и общие text-safe/path-safe/verdict-read не изменяются.
Shared verdict-read lazy continuation остаётся переданной оператору.

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-004.cjs [--a DIR] [--b DIR]`; the defaults are the two comparable review windows. Input: paired review reports. Output: candidates and reproduced escapes, exit 0 with nulls allowed, exit 0 with a compact refusal on an unreadable source; exit 2 on invalid arguments.
2. **Reproduce** (reviewer named by the owner). For each candidate: one reproduction against the same defect; without it the candidate stays a candidate. Input: the candidate. Output: the reproduction line in the journal.
3. **Read** (owner). The reproduced escapes feed the seat calibration of M-005. Input: the values. Output: the calibration decision.

## Stop conditions

Stop and go to P-L0-002 when a candidate cannot be checked because its earlier corpus is unreadable; the candidate stays open, never counted.

## Back edges

None.

## Evidence

- C - the design is the metric row M-004; the consumer is the certifier calibration (PROTO-DEC-0047 item 4).
- C - the leaf script exists (docs/ops/metrics/M-004.cjs) with the candidate-not-proof rule in its header.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A candidate is read as a proven escape | medium | high | R-L6-M004.2 names the candidate share and leaves reproduction to the reviewer | one reproduction | an impatient reader |
| A re-opened package is miscounted as escaped | low | medium | the same-defect check ties the FAIL to the original defect | none | a paraphrased defect |

## Change log

- 0.1 — 2026-10-14

- 0.2 — 2026-10-15
- 0.3 — 2026-10-15

- 0.4 — 2026-10-15

- 0.6 — 2026-10-15

- 0.7 — 2026-10-15

- 0.8 — 2026-10-15
- 0.9 — 2026-10-16
