---
id: TOOL-cert-launch
version: 0.2
title: Запуск назначенного независимого сертификатора
layer: L3
type: tool
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0041, PROTO-DEC-0192]
roles: [coordinator, dispatcher]
stages: [dispatch, execute, accept, session]
triggers: [owner-directive]
inputs: [docs/ops/cert-launch.cjs]
outputs: [journal]
back_edges: []
enforcement: none
script_candidate: yes
evidence_class: [B]
evidence: [docs/ops/cert-launch.cjs:1, PROTO-DEC-0041]
cost_basis: unknown
---

# TOOL-cert-launch

## Purpose

Запуск назначенного независимого сертификатора. Паспорт фиксирует существующий интерфейс, чтобы отсутствие TOOL-записи не подменялось ссылкой на код. Код и принятые решения выше этого draft.

## Rules

- R-L3-cert-launch.1. Caller применяет контракт существующего инструмента по ссылке `docs/ops/cert-launch.cjs` и не выводит из паспорта новых полномочий.
- R-L3-cert-launch.2. Этот draft проходит P-L0-001: независимое review, акт владельца и publication до статуса active.

## Steps

1. Координатор проверяет назначение, baseline и входы: prompt UTF-8; ожидаемый short HEAD; явные client/model; effort из registry; report path при проверке отчёта.
2. Dispatcher или вызывающий модуль использует интерфейс: `--client C --model M --worktree W --name N --prompt-file F --expect-sha SHORT [--expect-report R]`.
3. Caller сопоставляет выход с этим запуском или проверкой: call/transcript diagnostic capture; launch-record/1; servedModel/tokens/cost; terminal summary.
4. Координатор сохраняет воспроизводимые результаты в своём журнале; независимый reviewer отдельно проверяет кандидат.

## Caller contract

Запускать в изолированном worktree на указанном SHA; независимость и servedModel проверять вне авторского текста; dry-run не проверяет все preflight gates.

Inputs: prompt UTF-8; ожидаемый short HEAD; явные client/model; effort из registry; report path при проверке отчёта.

Outputs: call/transcript diagnostic capture; launch-record/1; servedModel/tokens/cost; terminal summary.

Version: passport 0.1; реализация определяется полным SHA дерева, launch artifact schemas — своим schema полем. Версия паспорта не версия клиента.

## Capabilities and rights

REPO_READ, FS_WRITE, SHELL_EXEC; сеть только через явно разрешённый client; сертификатор отдельно имеет EVIDENCE_SIGN. Capabilities назначает orchestrator, не паспорт. Чтение документа не подтверждает наличие этих capabilities.

## Failure contract

2 на usage/preflight/effort refusal; 3 packet refusal; результат клиента и report check могут дать failure. Отсутствие вердикта не есть завершённый отчёт.

## Stop conditions

Недостаточные права, неизвестный вход, расхождение с принятым решением или frozen reference: остановить данный шаг и перейти к P-L0-002. Никакой неудачный запуск не заменяется утверждением об успешном завершении.

## Back edges

Нет внутренних повторов в паспорте. Повторы инструмента ограничивает caller; passport не добавляет retry budget.

## Evidence

- B — отсутствующий паспорт измерен в JSON-реестре и inventory базы. Цена по времени неизвестна.
- Интерфейс: `docs/ops/cert-launch.cjs:1`; binding basis: PROTO-DEC-0041. Golden regression — наличие и полнота draft.
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
