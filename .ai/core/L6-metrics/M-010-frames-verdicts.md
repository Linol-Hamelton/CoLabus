---
id: M-010
version: 0.11
title: Frames with a recorded verdict against open frames, by stream; bypasses and long blocks
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [owner, coordinator, researcher]
stages: [research, close]
triggers: [frame-open, frame-closure]
inputs: [task-frame, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-010.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-010.cjs:2, .ai/core/L0-meta/P-L0-008-research-governor.md:233, .ai/core/L0-meta/P-L0-008-research-governor.md:139]
---

# M-010 Frames with verdicts against open frames

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The trial of P-L0-008 names this metric.

## Purpose

Research frames multiplied faster than decisions were built (R-L0-22). The governor lives
only if frames end in bounded rounds and per-stream limits hold. This metric counts frames
with a recorded verdict against open frames by stream, bypass incidents, streams blocked by
the harness itself for more than a day, and the special verdicts, so the governor's trial
and the implement-first mode have their number.

## Rules

- R-L6-M010.1. Канонический формат: render(parse(region)) побайтно равен исходной таблице: | cell |, delimiter | --- |, LF, без escapes/табуляции/пустых строк внутри; уникальные ASCII ids/counters; headers/12 и 4 столбца из canonical-frames.cjs, закрытые stream/status/counter vocabulary. Scope: только `## Frames` и `## Counters` docs/research/FRAMES.md (или --frames), до следующего level-1/2 ATX heading; текст вне секций и крайние пустые строки вокруг таблицы out of declared scope. Fail-closed: любая иная строка внутри scope обнуляет value A с non-canonical-input, firstOffendingLine и offendingLines с первой физической строкой; счётчик различий не обещан. A — доля open среди recognized frames; verdictedShare=null, Record непрозрачен. B читает весь --closures JSONL по тому же render/parse контракту M-011; duplicate receipt также обнуляет B.
- R-L6-M010.2. Канонический формат: render(parse(region)) побайтно равен исходной таблице: | cell |, delimiter | --- |, LF, без escapes/табуляции/пустых строк внутри; уникальные ASCII ids/counters; headers/12 и 4 столбца из canonical-frames.cjs, закрытые stream/status/counter vocabulary. Scope: только `## Frames` и `## Counters` docs/research/FRAMES.md (или --frames), до следующего level-1/2 ATX heading; текст вне секций и крайние пустые строки вокруг таблицы out of declared scope. Fail-closed: любая иная строка внутри scope обнуляет value A с non-canonical-input, firstOffendingLine и offendingLines с первой физической строкой; счётчик различий не обещан. Код/HTML/comment/list/quote/вторая таблица внутри scope не маскируются, а дают отказ.
- R-L6-M010.3. Канонический формат: render(parse(region)) побайтно равен исходной таблице: | cell |, delimiter | --- |, LF, без escapes/табуляции/пустых строк внутри; уникальные ASCII ids/counters; headers/12 и 4 столбца из canonical-frames.cjs, закрытые stream/status/counter vocabulary. Scope: только `## Frames` и `## Counters` docs/research/FRAMES.md (или --frames), до следующего level-1/2 ATX heading; текст вне секций и крайние пустые строки вокруг таблицы out of declared scope. Fail-closed: любая иная строка внутри scope обнуляет value A с non-canonical-input, firstOffendingLine и offendingLines с первой физической строкой; счётчик различий не обещан. DIG_FLOOR=- остаётся counter-unknown; conflict/unsafe counters обнуляют A. Status vocabulary: CANDIDATE, ACTIVE, BLOCKED, SUSPENDED, CLOSED, TRANSITION-PENDING, not a frame; optional скобочная аннотация.
- R-L6-M010.4. Канонический формат: render(parse(region)) побайтно равен исходной таблице: | cell |, delimiter | --- |, LF, без escapes/табуляции/пустых строк внутри; уникальные ASCII ids/counters; headers/12 и 4 столбца из canonical-frames.cjs, закрытые stream/status/counter vocabulary. Scope: только `## Frames` и `## Counters` docs/research/FRAMES.md (или --frames), до следующего level-1/2 ATX heading; текст вне секций и крайние пустые строки вокруг таблицы out of declared scope. Fail-closed: любая иная строка внутри scope обнуляет value A с non-canonical-input, firstOffendingLine и offendingLines с первой физической строкой; счётчик различий не обещан. Пер-stream limits и trial не исполняются; [not mechanically enforced].
- R-L6-M010.5. Канонический формат: render(parse(region)) побайтно равен исходной таблице: | cell |, delimiter | --- |, LF, без escapes/табуляции/пустых строк внутри; уникальные ASCII ids/counters; headers/12 и 4 столбца из canonical-frames.cjs, закрытые stream/status/counter vocabulary. Scope: только `## Frames` и `## Counters` docs/research/FRAMES.md (или --frames), до следующего level-1/2 ATX heading; текст вне секций и крайние пустые строки вокруг таблицы out of declared scope. Fail-closed: любая иная строка внутри scope обнуляет value A с non-canonical-input, firstOffendingLine и offendingLines с первой физической строкой; счётчик различий не обещан. Freshness вручную; [not mechanically enforced].

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
Path: '-' или docs/ с сегментами [A-Za-z0-9._-]+; сегменты . и .., пустые внутренние сегменты, backslash, drive/absolute paths, завершающая точка и Windows device aliases запрещены; один завершающий slash допустим, без backticks. Остальные cells: ASCII letters,
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

1. **Run** (coordinator or researcher). `node docs/ops/metrics/M-010.cjs [--frames FILE] [--closures FILE]`; the defaults are the frames registry and the closures ledger. Input: frames and closures. Output: the per-stream table, exit 0 with nulls allowed, exit 0 with a compact refusal on an unreadable source; exit 2 on invalid arguments.
2. **Read** (reviewer named by the owner). At the trial review: are frames ending in bounded rounds, which stream is blocked by the harness. Input: the table. Output: the trial line in the journal.

## Stop conditions

Stop and go to P-L0-002 when the frames registry is unreadable; the metric stays unknown and the trial review is postponed, never run on a partial read.

## Back edges

None.

## Evidence

- C - the design is the metric row M-010; P-L0-008 names it as the trial metric of the governor.
- C - the leaf script exists (docs/ops/metrics/M-010.cjs) over the frames registry and closures ledger that exist.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| An unread stream reads as calm | medium | high | R-L6-M010.3 keeps it unknown | none | a registry with a broken table |
| The count is read as the limit | medium | medium | R-L6-M010.4 names R-L0-22 as the acting rule | none | none |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-15

- 0.5 — 2026-10-15

- 0.6 — 2026-10-15

- 0.7 — 2026-10-15

- 0.8 — 2026-10-15

- 0.9 — 2026-10-15

- 0.10 — 2026-10-15
- 0.11 — 2026-10-16
