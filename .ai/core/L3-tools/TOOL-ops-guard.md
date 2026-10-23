---
id: TOOL-ops-guard
version: 0.2
title: Проверка реестра процессов и кандидатов
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [docs/ops/ops-guard.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [docs/ops/ops-guard.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-ops-guard

## Purpose

Проверка реестра процессов и кандидатов. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-ops-guard.1. Caller применяет контракт существующего инструмента по ссылке `docs/ops/ops-guard.cjs` и не выводит из паспорта новых полномочий.
- R-L3-ops-guard.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: process register; candidates registry; точные branch tips/pin files; owner и stream для claims.
2. Dispatcher или вызывающий модуль использует интерфейс: `candidates, pin-check, claim, release, status, launch-gate; register --register docs/ops/PROCESS-REGISTER.md`.
3. Caller сопоставляет выход с этим запуском или проверкой: diagnostics; claims file только для claim/release.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

register — advisory проверка реестра; launch-gate проверяется перед spawn; успешная проверка не является актом приёмки.

Inputs: process register; candidates registry; точные branch tips/pin files; owner и stream для claims.

Outputs: diagnostics; claims file только для claim/release.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, SHELL_EXEC для Git; FS_WRITE только в claims; сам candidate не редактирует. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

0 проверка успешна, 1 refused/problem, 2 usage. Отсутствующие или разошедшиеся pins не считать accepted.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `docs/ops/ops-guard.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — наличие и полнота draft.
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
