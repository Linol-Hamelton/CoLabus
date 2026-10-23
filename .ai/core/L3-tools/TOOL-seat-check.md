---
id: TOOL-seat-check
version: 0.2
title: Проверка места сертификатора по записи запуска
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [docs/ops/seat-check.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [docs/ops/seat-check.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-seat-check

## Purpose

Проверка места сертификатора по записи запуска. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-seat-check.1. Caller применяет контракт существующего инструмента по ссылке `docs/ops/seat-check.cjs` и не выводит из паспорта новых полномочий.
- R-L3-seat-check.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: launch-record/1 из pending или journal; launchId/name, role/model/servedModel.
2. Dispatcher или вызывающий модуль использует интерфейс: `--name N [--launch-id L] [--pending DIR] [--journal FILE]`.
3. Caller сопоставляет выход с этим запуском или проверкой: read-only оценка места и код завершения.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Caller передаёт точный launchId при неоднозначном имени; seat-check не доказывает всю lineage независимости пары и не принимает candidate.

Inputs: launch-record/1 из pending или journal; launchId/name, role/model/servedModel.

Outputs: read-only оценка места и код завершения.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ; без spawn, сети, FS_WRITE или подписи Evidence. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

0 seat ok; 1 invalid seat; 2 usage/missing record. Неподтверждённая модель делает место недействительным.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `docs/ops/seat-check.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — наличие и полнота draft.
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
