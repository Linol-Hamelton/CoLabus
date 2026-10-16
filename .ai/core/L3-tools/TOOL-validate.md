---
id: TOOL-validate
version: 0.2
title: Валидатор протокола и кодировок
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0153, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [.ai/bin/protocol-validate.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [.ai/bin/protocol-validate.cjs:1, PROTO-DEC-0153]
cost_basis: unknown
---

# TOOL-validate

## Purpose

Валидатор протокола и кодировок. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-validate.1. Caller применяет контракт существующего инструмента по ссылке `.ai/bin/protocol-validate.cjs` и не выводит из паспорта новых полномочий.
- R-L3-validate.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: manifest; tracked/untracked protocol paths; Git; hooks; governance; tracked text.
2. Dispatcher или вызывающий модуль использует интерфейс: `node .ai/bin/protocol-validate.cjs --root . [--quiet]; API validate(root)`.
3. Caller сопоставляет выход с этим запуском или проверкой: diagnostics/counts/exitCode/coverage; optional timing diagnostic.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Caller проверяет exit/counts/coverage и отдельно product/targeted tests; validator0 не означает полный suite, PASS независимого ревью или отсутствие всех секретов.

Inputs: manifest; tracked/untracked protocol paths; Git; hooks; governance; tracked text.

Outputs: diagnostics/counts/exitCode/coverage; optional timing diagnostic.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, SHELL_EXEC локальных probes; основной validate не меняет candidate; FS_WRITE только optional timing. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

0 при отсутствии FAIL; 1 при FAIL/unknown CLI args. WARN не блокирует; неподдержанная проверка отражается в coverage.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре  и inventory базы; проблема перечислена в . Цена по времени неизвестна.
- Интерфейс: `.ai/bin/protocol-validate.cjs:1`; binding basis: PROTO-DEC-0153. Golden regression — , наличие и полнота draft.
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
