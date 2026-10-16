---
id: TOOL-registry
version: 0.2
title: Чтение и проверка клиентов и dispatch spec
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [.ai/bin/protocol-dispatch/registry.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [.ai/bin/protocol-dispatch/registry.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-registry

## Purpose

Чтение и проверка клиентов и dispatch spec. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-registry.1. Caller применяет контракт существующего инструмента по ссылке `.ai/bin/protocol-dispatch/registry.cjs` и не выводит из паспорта новых полномочий.
- R-L3-registry.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: clients/1 JSON; dispatch spec; relative paths; declared client command/model/effort metadata.
2. Dispatcher или вызывающий модуль использует интерфейс: `модуль loadRegistry, validateRegistry, loadDispatch; CLI facade protocol-dispatch.cjs check`.
3. Caller сопоставляет выход с этим запуском или проверкой: validated registry/spec либо exception; environment hash через существующий API.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Caller читает проектный registry один раз для данного решения, обрабатывает exception и present:false; tool passport не копирует модели/tiers и не выдаёт capabilities.

Inputs: clients/1 JSON; dispatch spec; relative paths; declared client command/model/effort metadata.

Outputs: validated registry/spec либо exception; environment hash через существующий API.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ; SHELL_EXEC для Git environment context по отдельному API; FS_WRITE/NETWORK не нужны. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

Missing/broken registry и unknown keys/schema дают exception; caller не подставляет автоматический разрешённый маршрут.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре  и inventory базы; проблема перечислена в . Цена по времени неизвестна.
- Интерфейс: `.ai/bin/protocol-dispatch/registry.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — , наличие и полнота draft.
- P-L0-001 steps 1-4/6: intake owner-directive ; home L3; class B; existing homes — code и procedure pointers, нового дома правил клиента нет. Steps 7-10 pending independent review/owner/publish. CATALOG/RULE-MAP и pending registry меняет integrator в разрешённом write-set.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Паспорт отстаёт от кода | medium | неверный вызов | reviewer сверяет указанный файл и SHA | targeted review | caller пропустил проверку |
| Draft приняли за права или сертификацию | medium | обход приёмки | draft и явный caller contract | unknown | требуется независимая пара |
| Результат чужого запуска принят как свой | medium | неверная модель/приёмка | caller связывает identity входа и выхода | unknown | достоверность внешнего источника |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-16
