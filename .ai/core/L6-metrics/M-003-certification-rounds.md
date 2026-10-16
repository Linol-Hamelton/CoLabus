---
id: M-003
version: 0.9
title: Certification rounds per package and empty rounds; rounds per root cause
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator, certifier]
stages: [accept, freeze]
triggers: [verdict:FAIL, candidate-frozen]
inputs: [review-report, findings-ledger]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-003.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-003.cjs:2, PROTO-DEC-0168:3]
---

# M-003 Certification rounds per package

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act.

## Purpose

Every certification round costs two seats and days of wall time. An empty round - a FAIL
without a new root cause - is pure waste, and a root cause that needs round after round
says the package is too wide. This metric counts rounds per package, rounds per root cause
and empty rounds, feeding the package budget decision and the K7 stop card.

## Rules

- R-L6-M003.1. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Один canonical review = один файл-раунд; emptyRounds=null, нет root-cause join. ( section 6, row M-003). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts] [test:  :: L5L6 N2 M-010 M-011 M-003 M-004 refused regions publish no measurements] [test:  :: L5L6 K3 M-010 M-011 M-003 M-004 refused sources publish only the refusal shape]
- R-L6-M003.2. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Неизвестный review другого slug также обнуляет среднее. ( section 6, row M-003). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts] [test:  :: L5L6 N2 M-010 M-011 M-003 M-004 refused regions publish no measurements] [test:  :: L5L6 K3 M-010 M-011 M-003 M-004 refused sources publish only the refusal shape]
- R-L6-M003.3. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Пустой corpus даёт value=null/no-records. ( section 6, row M-003). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts] [test:  :: L5L6 N2 M-010 M-011 M-003 M-004 refused regions publish no measurements] [test:  :: L5L6 K3 M-010 M-011 M-003 M-004 refused sources publish only the refusal shape]
- R-L6-M003.4. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. K7 не исполняется этой метрикой; [not mechanically enforced]. ( section 6, row M-003). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts] [test:  :: L5L6 N2 M-010 M-011 M-003 M-004 refused regions publish no measurements] [test:  :: L5L6 K3 M-010 M-011 M-003 M-004 refused sources publish only the refusal shape]
- R-L6-M003.5. Канонический формат: YYYY-MM-DD-slug-seat(-op).md (реальная дата, ASCII lower-case slug, seat из KNOWN_SEATS shared module), header `# Review` + `Mode: CERTIFYING`, последняя собственная строка `Verdict: TOKEN`. Scope: все файлы рекурсивно в --a/--b (default docs/reviews), включая archive/R2/catalog; канонический review вне окна даты именуется excluded-by-declared-scope. Fail-closed: любой non-canonical review обнуляет value всего пакета с non-canonical-input; компактный отказ K3 без счётчика различий. Freshness и открытие раунда — вручную, [not mechanically enforced]. ( section 6, row M-003). [test:  :: L5L6 W2 M-001 M-003 M-004 M-005 share a complete recursive classification] [test:  :: L5L6 W6 M-001 M-003 M-004 M-005 M-010 M-011 records state only tested canonical contracts] [test:  :: L5L6 N2 M-010 M-011 M-003 M-004 refused regions publish no measurements] [test:  :: L5L6 K3 M-010 M-011 M-003 M-004 refused sources publish only the refusal shape]

## Strict round 7

Авторская реализация; независимая сертификация ожидается.

K1 заменяет N1/Y2 в части определения enforcing. R7 запускает каждый названный
файл через node --test с точным набором имён и JSON machine reporter. Только один
top-level test:pass, exit 0, без skip/todo считается исполненным. Статический
прямой assert/assert.* до return/throw остаётся вторым независимым условием.
Распознавания вариантов вызова skip/todo больше нет. Пустой callback, assertion
только внутри ветки/цикла, отсутствующий/дублированный тест не дают enforcement.
Runtime options с вычисляемым skip:false допустимы. Timeout/ошибка reporter дают
отказ; результат кешируется только в процессе по исходнику, пути и набору имён.
Это не доказывает корректность произвольной подмены assert или внешнего helper.
W6 проверяет текст records; независимые R7/U5 проверяют runtime coverage, чтобы
названный enforcing W6 не запускал самого себя через coverage рекурсивно.

K2 заменяет N6. Действует закрытая грамматика каждого столбца, а не перечень видов
Markdown. Frame ID и Stream: [A-Z0-9-]+ плюс существующие точные field contracts.
Path: '-' или docs/[A-Za-z0-9./-]+, без backticks. Остальные cells: ASCII letters,
digits, space и . , : ; / ( ) ' -; точка/двоеточие завершают token (далее space
или конец), поэтому URL/autolink не проходит. Counter: точное имя из COUNTERS,
в том числе DIG_FLOOR и DEFERRED_ACCEPTED. Headers/delimiters имеют отдельный
фиксированный формат. Любой другой символ даёт отказ, включая одиночные tilde,
underscore, backslash и non-ASCII; нет Unicode normalisation или markup-kind gate.

K3 заменяет N2. Отвергнутый пакет M-003/M-004/M-010/M-011 содержит ТОЛЬКО
{value:null, reason, firstOffendingLine, offendingLines}. Последний массив содержит
не более 20 уникальных положительных физических адресов, первый адрес либо null.
Никаких счётчиков, lists, denominator, bytes, sha256, records или unknowns внутри
такого пакета. CLI sources тоже содержит этот отказ; верхний unknowns имеет лишь
причину, без чисел в пояснениях. У принятого пакета обычные измерения сохранены.

K4 заменяет обещание N5 о числе различий. M-010 Frames сообщает ТОЛЬКО первую
физическую строку отказа и offendingLines из одного адреса. Полного счётчика
различий нет; адрес не выходит за EOF. JSONL сохраняет до 20 адресов, без count.
Внутренний parser diagnostic не является опубликованным измерением.

K5: ошибки чтения, decode, parse, render и вычисления пакета локализованы и дают
source-unreadable/source-undecodable/source-exception либо non-canonical-input.
Когда физическая строка известна, она сохраняется. BOM посреди строки и lone CR
дают отказ, не исключение из leaf. CLI при отказе источника выдаёт JSON и exit 0;
exit 2 означает ошибку аргументов. Отдельные A/B сохраняют независимость источников.

K6: именованный тест проверяет heading без финального LF и уникальность внутренних
unknownUnits для одной повреждённой строки. Обе исходные мутации C6 теперь убиты.
Удаление de-dup guard было эквивалентно для публичного Set, но изменяет raw
diagnostic; тест проверяет именно этот существующий внутренний контракт.

N3 (общий fieldIssues после round trip до slice), N4 (исходные байты scope edges),
N7 (commit locator [a-f0-9]{1,40} без trim) сохранены. Y1/Y3/Y4 сохраняют полный
корпус отказов и число проверенных cases; Y4 не обещает число source offences.
W1-W7 сохранены с публикацией по K3/K4. Assertions о parser-level counters,
receipt/frame/commit и конфликте остаются отдельно от проверки compact refusal.
FRAMES.md, CLOSURES.jsonl и общие text-safe/path-safe/verdict-read не изменяются.
Shared verdict-read lazy continuation из N7 остаётся переданным оператору.

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-003.cjs [--a DIR] [--b DIR]`; the defaults are the two comparable review windows. Input: paired review reports. Output: rounds and empty rounds per package, exit 0 with nulls allowed, exit 0 with a compact refusal on an unreadable source; exit 2 on invalid arguments.
2. **Read** (owner, coordinator). Before a new round: does this root cause already have its rounds; is the last FAIL a new reproduced reason or an empty round. Input: the numbers. Output: the K7 card or the next round.

## Stop conditions

Stop and go to P-L0-002 when the review corpus is unreadable or a verdict cannot be read from a report that claims one.

## Back edges

None.

## Evidence

- C - the design is  section 6 row M-003; the acting consumer is the K7 card ( row 5, PROTO-DEC-0168 item 3).
- C - the leaf script exists (docs/ops/metrics/M-003.cjs) with the review-file grammar and verdict reader.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A FAIL with a reworded old reason counts as new | medium | high | R-L6-M003.1 explicitly cannot distinguish root causes; operator review is manual | none | a reviewer who paraphrases |
| The count is read as the gate itself | medium | medium | R-L6-M003.4 names K7 as the acting rule | none | a reader who skips the rule |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-15

- 0.5 — 2026-10-15

- 0.6 — 2026-10-15

- 0.7 — 2026-10-15

- 0.8 — 2026-10-15
- 0.9 — 2026-10-16
