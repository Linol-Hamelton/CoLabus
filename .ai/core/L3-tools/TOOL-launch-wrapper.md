---
id: TOOL-launch-wrapper
version: 0.2
title: Обёртка запуска и учёта завершения
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0169, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [docs/ops/launch-wrapper.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [docs/ops/launch-wrapper.cjs:1, PROTO-DEC-0169]
cost_basis: unknown
---

# TOOL-launch-wrapper

## Purpose

Обёртка запуска и учёта завершения. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-launch-wrapper.1. Caller применяет контракт существующего инструмента по ссылке `docs/ops/launch-wrapper.cjs` и не выводит из паспорта новых полномочий.
- R-L3-launch-wrapper.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: stream, owner, name, worktree; candidate pins/registry; argv; log/runtime; engine legacy по умолчанию.
2. Dispatcher или вызывающий модуль использует интерфейс: `run --stream S --owner O --name N --worktree W -- command; watch; status; selftest`.
3. Caller сопоставляет выход с этим запуском или проверкой: running/terminal JSON, marker, claims, launch-record; diagnostic capture.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Вызвавший проверяет terminal record и reportVerdict отдельно; запуск разрешён owner route; --no-gate не даёт новой власти.

Inputs: stream, owner, name, worktree; candidate pins/registry; argv; log/runtime; engine legacy по умолчанию.

Outputs: running/terminal JSON, marker, claims, launch-record; diagnostic capture.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, FS_WRITE, SHELL_EXEC; может запускать и останавливать только собственный дочерний процесс; watch пишет terminal markers. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

run: exit дочернего процесса, 3 gate refusal, 2 usage; signal=1. watch: 1 если обнаружена silent death, иначе 0; report=ok не означает PASS.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `docs/ops/launch-wrapper.cjs:1`; binding basis: PROTO-DEC-0169. Golden regression — наличие и полнота draft.
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
