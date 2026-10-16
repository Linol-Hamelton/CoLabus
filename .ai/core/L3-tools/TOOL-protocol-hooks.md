---
id: TOOL-protocol-hooks
version: 0.2
title: Общая логика SessionStart и Stop
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0038, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [.ai/bin/protocol-hooks.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [.ai/bin/protocol-hooks.cjs:1, PROTO-DEC-0038]
cost_basis: unknown
---

# TOOL-protocol-hooks

## Purpose

Общая логика SessionStart и Stop. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-protocol-hooks.1. Caller применяет контракт существующего инструмента по ссылке `.ai/bin/protocol-hooks.cjs` и не выводит из паспорта новых полномочий.
- R-L3-protocol-hooks.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: trusted session identity; git snapshot; свой worklog; TASK/PLAN/DECISIONS и inventory.
2. Dispatcher или вызывающий модуль использует интерфейс: `адаптер вызывает main(namespace); события SessionStart/Stop получают JSON stdin cwd/session_id`.
3. Caller сопоставляет выход с этим запуском или проверкой: bounded context; собственный journal scaffold; runtime snapshots/metrics; warning telemetry.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Адаптер сохраняет поддерживаемую схему ответа своего клиента; Stop предупреждает, не блокирует; handoff требует пяти заполненных меток.

Inputs: trusted session identity; git snapshot; свой worklog; TASK/PLAN/DECISIONS и inventory.

Outputs: bounded context; собственный journal scaffold; runtime snapshots/metrics; warning telemetry.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, SHELL_EXEC Git, FS_WRITE journal/runtime; не получает полномочий на shared документы. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

Malformed/missing state даёт visible warning; unchanged/incomplete entry не закрывает изменённое дерево; read-only session не требует фиктивного handoff.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре  и inventory базы; проблема перечислена в . Цена по времени неизвестна.
- Интерфейс: `.ai/bin/protocol-hooks.cjs:1`; binding basis: PROTO-DEC-0038. Golden regression — , наличие и полнота draft.
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
