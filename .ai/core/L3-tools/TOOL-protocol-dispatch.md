---
id: TOOL-protocol-dispatch
version: 0.2
title: Диспетчер слотов с явным маршрутом
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [.ai/bin/protocol-dispatch.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [.ai/bin/protocol-dispatch.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-protocol-dispatch

## Purpose

Диспетчер слотов с явным маршрутом. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-protocol-dispatch.1. Caller применяет контракт существующего инструмента по ссылке `.ai/bin/protocol-dispatch.cjs` и не выводит из паспорта новых полномочий.
- R-L3-protocol-dispatch.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: dispatch YAML/JSON; .ai/docs/clients.json; baseline/scope; параметры клиента и усилий.
2. Dispatcher или вызывающий модуль использует интерфейс: `check/run/status/report/stop/accept через CLI facade; определения в protocol-dispatch/cli.cjs`.
3. Caller сопоставляет выход с этим запуском или проверкой: run-record/1, attempt logs, scratch workdir, отчёт слотов.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

check сначала; run только после назначения. stop требует идентичности процесса; accept не заменяет сертификацию.

Inputs: dispatch YAML/JSON; .ai/docs/clients.json; baseline/scope; параметры клиента и усилий.

Outputs: run-record/1, attempt logs, scratch workdir, отчёт слотов.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, FS_WRITE, SHELL_EXEC; запуск клиента имеет внешние эффекты и требует явного owner route. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

CLI сообщает ошибки входа/проверок; состояние UNKNOWN или NOT_STARTED не считается успешным запуском. Коды команд читать в cli.cjs, не считать один exit универсальным.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `.ai/bin/protocol-dispatch.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — наличие и полнота draft.
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
