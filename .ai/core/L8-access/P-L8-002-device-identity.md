---
id: P-L8-002
version: 0.1
title: Device authority - registration, owner approval, revocation and fresh public credentials
layer: L8
type: procedure
status: review
owner_approval: PROTO-DEC-0255
decision: [PROTO-DEC-0255]
roles: [all]
stages: [any]
triggers: [owner-directive]
inputs: [.ai/core/schema/device-authority.schema.md, .ai/DECISIONS.md]
outputs: [review-report]
back_edges: []
enforcement: P
script_candidate: yes
evidence_class: [C]
evidence: [PROTO-DEC-0255:1]
cost_basis: unknown
---

# P-L8-002 Идентификация устройств

## Purpose

Общая authority отделяет права устройств от фермы, моделей и включённости ПК владельца.
R2a реализует офлайн state machine и публичный mock endpoint. Запись находится на review;
серверный/delivery verifier, проверка каждого request/commit и интеграция остаются R2b.
В поставляемом ядре это текстовый контракт; исполняемый прототип и его execution map
остаются в исходном репозитории до квалификации production host.

## Rules

- R-L8-002.1. Все коннекторы используют один реестр authority из pseudonym, publicKey, generation и status, без заказов, путей и частных результатов.
- R-L8-002.2. Ключи устройства, администратора, authority и фермы разделены; регистрация не выдаёт права, неизвестное устройство получает отказ.
- R-L8-002.3. Регистрация доказывает владение ключом, а approve/revoke выполняет только владелец отдельной подписью admin и повторным подтверждением точного действия.
- R-L8-002.4. Подтверждение связано с одноразовым challenge, authority, epoch, ключом, действием, digest параметров и сроком; replay и устаревшие поколения запрещены.
- R-L8-002.5. Только approved устройство получает сертификат для разрешённых audience/features; revoke повышает generation, а новый ключ отозванного устройства требует новой регистрации и approval.
- R-L8-002.6. Публичные документы имеют закрытые канонические схемы, доменно разделённые Ed25519 подписи и внешний закреплённый ключ; сертификат живёт не более 600 s.
- R-L8-002.7. Authority публикует monotonic snapshot не реже 30 s и сразу при изменении реестра; snapshot старше 60 s, rollback часов и uncertainty свыше 5 s закрывают выдачу полномочий.
- R-L8-002.8. Публичный endpoint принимает только registration, certificate, соответствующие challenge и snapshot; административные операции и произвольные команды там недоступны.
- R-L8-002.9. Смена root/admin key требует подтверждения владельца (для admin также нового credential), увеличивает epoch/generation, сбрасывает pending challenges и требует заново одобрить ранее approved устройства.
- R-L8-002.10. Backup содержит только подписанное публичное состояние; owner-authorized recovery принимает точный внешний checkpoint, увеличивает epoch/sequence/generation и сохраняет отзыв.
- R-L8-002.11. Decommission необратимо закрывает выдачу и продление полномочий в данном экземпляре, сохраняя подписанный последний snapshot для потребителей.

## Steps

1. Владелец задаёт authority ID, отдельные root/admin pins, запрещённые farm key IDs,
   audience/features и доверенные wall/monotonic/uncertainty clock inputs.
2. Устройство подписывает challenge регистрации; authority добавляет pending строку.
3. Владелец сверяет pseudonym/publicKey/generation и подписывает approve с confirmed=true.
4. Устройство получает сертификат после новой PoP; host вызывает tick каждые <=30 s.
5. Владелец отзывает/выводит устройство либо authority из эксплуатации; snapshot выходит сразу.
6. Владелец отдельно закрепляет backup checkpoint и выполняет recovery/rotation при необходимости.

## Stop conditions

Любой неизвестный input, подпись, ключ, scope, время или состояние — отказ без выдачи.
Clock fault фиксируется до нового доверенного экземпляра с owner recovery; tick не снимает fault.
До квалификации постоянного хоста, durable high-water store, TLS/mTLS и OS key store
production activation отсутствует. Mock не обращается в сеть и не открывает listener.
Владелец вне online-моделей держит admin credential; устройство — OS credential store/TPM
при наличии поддержки. R2a принимает KeyObject через доверенный host boundary и не читает stores.

## Back edges

Нет автоматического повторного approval, восстановления или обхода отказа.

## Evidence

- C: PROTO-DEC-0255 п.1; утверждённый дизайн, разделы 8 и 9, раунд R2a.
- Офлайн проверки R2a в исходном репозитории: каждый rule покрыт oracle и source mutant.
  Это авторские проверки, а не независимая certification или проверка реального сервера.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
| --- | --- | --- | --- | --- | --- |
| Старый backup/checkpoint подменён вместе | unknown | high | внешний owner checkpoint | один pin | durable nonrollback store квалифицирует host |
| Host не вызывает tick или теряет authority | unknown | high | snapshot expiry закрывает выдачу | clock check | R2b закрывает gated requests/commit, bound 65 s с skew |
| Похищен root/admin key | unknown | high | разделение ключей, rotation/recovery | owner act | TPM/TLS и защищённый сервер вне офлайн доказательства |
| Коннектор трактует cert как feature grant | unknown | high | audience/features и отдельные connector grants | R2b | R2a не разрешает server feature сам по себе |

## Change log

- 0.1 — 2026-11-06
