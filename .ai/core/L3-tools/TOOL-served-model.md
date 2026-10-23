---
id: TOOL-served-model
version: 0.2
title: Определение реально ответившей модели
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [docs/ops/served-model.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [docs/ops/served-model.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-served-model

## Purpose

Определение реально ответившей модели. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-served-model.1. Caller применяет контракт существующего инструмента по ссылке `docs/ops/served-model.cjs` и не выводит из паспорта новых полномочий.
- R-L3-served-model.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: client output/logs для этого launch window и workdir; requestedModel только для сравнения.
2. Dispatcher или вызывающий модуль использует интерфейс: `модуль deriveServedModel({client, requestedModel, capturedOutput, startedAt, endedAt, logDir, workdir}); CLI отсутствует`.
3. Caller сопоставляет выход с этим запуском или проверкой: {servedModel, source, confidence, match, detail}; nullable неизвестное.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Caller связывает вывод с текущим launch и записывает recordFields; текст отчёта не источник модели; пользовательские пути/сырой capture не публиковать.

Inputs: client output/logs для этого launch window и workdir; requestedModel только для сравнения.

Outputs: {servedModel, source, confidence, match, detail}; nullable неизвестное.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ логов; pure output derivation, FS_WRITE/SHELL_EXEC/NETWORK не требуются. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

Неполные/неизвестные источники возвращают null/none/unknown; match unknown не независимость и не подтверждение модели.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `docs/ops/served-model.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — наличие и полнота draft.
- P-L0-001 steps 1-4/6: intake owner-directive; home L3; class B; existing homes — code и procedure pointers, нового дома правил клиента нет. Steps 7-10 pending independent review/owner/publish. CATALOG/RULE-MAP и pending registry меняет integrator в разрешённом write-set.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Паспорт отстаёт от кода | medium | неверный вызов | reviewer сверяет указанный файл и SHA | targeted review | caller пропустил проверку |
| Draft приняли за права или сертификацию | medium | обход приёмки | draft и явный caller contract | unknown | требуется независимая пара |
| Результат чужого запуска принят как свой | medium | неверная модель/приёмка | caller связывает identity входа и выхода | unknown | достоверность внешнего источника |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-16
