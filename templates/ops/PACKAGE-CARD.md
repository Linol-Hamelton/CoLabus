# Карточка пакета — приложение к существующему заданию

Заполнить по docs/ops/ANALYST-PIPELINE.md до старта автора. Не заменяет task-frame.
Не путать certification-tier (0–4) с tier сложности T1..T9.

- package-id: <постоянный идентификатор пакета>
- task-frame: <путь существующего задания>
- analysis-baseline: <полный SHA до реализации>
- certification-tier: <0..4, предложение оператора / акт владельца>
- tier-reason: <критерий PROTO-DEC-0232 и самый критичный компонент>
- tier-source: <строка реестра кандидатов / акт владельца>

## DESIGN REVIEW

Для Class A обязательно до начала реализации: каждая гарантия, конструкция или открытая
граница; open-ended направить владельцу до старта автора (PROTO-DEC-0212).
Для остальных указать применимость и причину, не молча удалять блок.

| guarantee | closure | construction-or-boundary | check | owner-disposition |
|---|---|---|---|---|
| <гарантия> | <closed-by-construction / open-ended> | <устройство / граница> | <проверка> | <решение / pending / не требуется> |

## Analyst to certifier

По одной постоянной строке на пару; тот же участник анализирует и сертифицирует
тот же package-id. До автора все поля анализа заполнены, финальные — pending.
TIER 0: строк нет, причина отсутствия мест указана в tier-reason.
Для нового раунда сохранить прежнюю таблицу, новую пометить round-id.

| package-id | analyst-id | family | model | strength-basis | analyst-note | analysis-baseline | certifier-id | certification-report | certification-baseline |
|---|---|---|---|---|---|---|---|---|---|
| <пакет> | <участник> | <семейство> | <модель> | <основание силы, strong где назначено> | <путь записки> | <полный SHA> | <тот же участник> | pending | pending |

## Изменения состава

- round-id: <раунд>
- replacement-or-tier-change: <нет / причина, старая и новая пара>
- independence-check: <проверка всей авторской линии и управления>
- pre-start-analysis-check: <пути записок, время до старта / pending>
