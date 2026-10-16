---
id: SCHEMA-client-profile
version: 0.1
title: Client profile - registry wire shape and measured execution boundary
layer: L3
type: schema
status: draft
evidence_class: [B, C]
cost_basis: unknown
evidence: [.ai/bin/protocol-packet.cjs:518-547, .ai/bin/protocol-dispatch/workdir.cjs:59-96]
---

# Профиль клиента

Авторский draft S4-T01 по P-L0-001. Дом профиля инструмента — L3;
измеренный опыт клиента остаётся в L4 APP-карточках. Это описание существующего
`clients/1`, не approved supersession, не подтверждение доступности провайдера.
Потребители: protocol-dispatch/clients, cert-launch, fix-launch, protocol-packet.
Текущий дом данных `.ai/docs/clients.json`; переход в L3-tools требует отдельной
посадки с обновлением всех потребителей. Здесь данные не перемещаются.

## Rules

- R-L3-client-profile.1. `schema` равен `clients/1`; `clients` — объект записей по id клиента. Отсутствующая запись и `present: false` не разрешают запуск.
- R-L3-client-profile.2. Наблюдение имеет дату и источник; неизвестная способность остаётся unknown/null. Наличие бинарника не доказывает права, модель, авторство или актуальную квоту.
- R-L3-client-profile.3. `command` — argv-шаблон, не shell-строка; адаптер shell имеет отдельную проверку. Значения модели, усилия и роли выбираются слоем назначения, не этой схемой.
- R-L3-client-profile.4. `executionObservation` описывает только указанный boundary и источник. detect-only не является предотвращением; unknown никогда не становится разрешением.
- R-L3-client-profile.5. Профиль рабочей машины не является профилем установленного проекта. Пути, auth и персональные данные текущего registry не копируются в публичный продукт; host получает схему и собственный registry.

## Отображение старого контракта

|  | Текущий clients/1 | Ограничение |
|---|---|---|
| client | ключ clients, `id`, `binary` | maker/provider берутся из слоя назначения |
| version, verified | `version`, `verifiedOn`, `source` | даты CLI наблюдений не обновляются от чтения кода |
| executable, shim | `binary`, `path` | path — локальные данные; adapter проверяет способ вызова |
| argv | `command` | строки и условные `{if, args}`; подстановка в clients.cjs |
| env | `env` | значения не печатаются и не служат доказательством auth |
| models, effort, tiers | `models`, `model`, `effort` | tiers здесь не добавляются; selection layer |
| permission | `capabilities`, `executionObservation` | capability не равна разрешению текущей задачи |
| timeBound | executor options | локальная deadline policy, не выдуманный CLI флаг |
| sessionIdFrom, resume | `resume` | null — отсутствие доказательства поддержки |
| artifacts | executor lease и session store | наблюдения относятся к своей сессии |
| failureModes | `failureModes` | pattern/class/cause/countermeasure; L4 хранит опыт |
| `enforcement` | `executionObservation.noCommit` | неиспользуемое legacy поле не добавляется как gate |
| compiler budget | `packetSoftTokens` | положительное целое, проверяет compiler |

## Execution observation

Закрытая форма: boundary=`dispatch-postflight`, noCommit=`detect-only`,
authentication=`unknown`, observedOn=UTC дата проверки кода, source=path:line.
На 2026-10-14 workdir.cjs сравнивает HEAD и write-set; это наблюдение локального
кода для каждого registry entry, а не проба всех двенадцати реальных клиентов.
CLI capabilities, версии и источники 2026-10-04/05 сохранены без повышения
достоверности. `fileWrite: true` использован compiler как legacy fallback для
чтения только при отсутствии fileRead; unknown не считается true.

## Самоприменимость и приёмка

P-L0-001: intake=A8-PROFILE, class B/C, draft, independent review и owner act
ещё требуются. Новые правила не активируются. Canonical schema и provenance
проверяются ; потребители проверяются их suites.
CATALOG/RULE-MAP regenerates интегратор после приёмки; автор их не редактирует.

## Risks

| Риск | Покрытие | Остаток |
|---|---|---|
| stale CLI snapshot | исходная дата/источник сохраняются | offline не подтверждает live capability |
| широкие shell права | сила границы названа detect-only | злонамеренный shell не изолирован ОС |
| обещание от metadata | draft и unknown | owner act и sealed pair ещё нужны |

## Change log

- 0.1 — 2026-10-14
