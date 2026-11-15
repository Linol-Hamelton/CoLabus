---
id: SCHEMA-device-authority
version: 0.1
title: Closed public device authority documents and offline host boundary
layer: L8
type: schema
status: review
evidence_class: [C]
evidence: [PROTO-DEC-0255:1]
decision: [PROTO-DEC-0255]
---

# Контракт device authority

Closed-schema словарь и реализация подписи находятся в исходном прототипе R2a.
Канонический JSON reader/JCS переиспользует контракт manifest R1a.
Нормативные правила: см. P-L8-002. Формат не является X.509 и не меняет farm pairing.

| Документ / schema | Публичные поля |
| --- | --- |
| colabus-device-challenge/1 | authorityId, epoch, keyId, action, requestDigest, nonce, issuedAt, validUntil |
| colabus-device-proof/1 | challenge, confirmed |
| colabus-device-certificate/1 | authorityId, epoch, keyId, deviceId, publicKey, generation, audience, features, serial, issuedAt, validUntil |
| colabus-device-snapshot/1 | authorityId, epoch, keyId, sequence, revision, issuedAt, validUntil, devices |
| colabus-device-backup/1 | authorityId, epoch, keyId, sequence, revision, issuedAt, disabled, devices |

Каждый signed document — ровно `{payload,signature}`; payload включает поле schema.
Подпись 64 bytes Ed25519 кодируется canonical base64url без padding.
Signing bytes: ASCII `colabus-l8-<kind>/1` + NUL + JCS payload.
keyId — `sha256:` DER SPKI, publicKey — canonical base64url DER SPKI Ed25519.
Device row — ровно `{deviceId,publicKey,generation,status}`, сортировка по ASCII deviceId;
status = pending/approved/revoked/decommissioned; не более 256 уникальных ID и ключей.
ID — lowercase ASCII slug <=64; epoch/generation/sequence положительные safe integers;
revision и UTC timestamps в ms — неотрицательные safe integers. Clock uncertainty также в ms.
Списки features уникальны, 1..32; audience policy задаёт доверенный host, не manifest клиента.
Подпись/JSON/schema проверяются до использования значений, неизвестные поля запрещены.
Канонический документ <=128 KiB; запрос <=16 KiB, body <=8 KiB; challenge queue <=1024.

## Host API

`createAuthority({authorityId,privateKey,adminPublicKey,clock,audiences,forbiddenKeyIds,recoveryFloor})`
создаёт один synchronous экземпляр. Сеть, filesystem и фоновые процессы отсутствуют.
privateKey — injected Ed25519 private KeyObject; clock возвращает
`{wallMs,monotonicMs,uncertaintyMs}` из доверенного host, а не timestamp запроса.
Admin имеет отдельный owner-controlled endpoint; mockPublicServer его не маршрутизирует.
Admin proof включает confirmed=true и точный pseudonym/key/generation или digest операции.
Указанные функции — kernel byte API; ни одна не вызывает OS store, shell, модель или farm.

`challenge(action, body)` возвращает подписанный challenge для последующего proof.
Proof подписывается ключом устройства для register/certificate, отдельным admin key для
approve/revoke/decommission-device/decommission-authority/rotate-authority/rotate-admin/backup/recover.
`register`, `admin`, `certificate`, `tick`, `snapshot`, `backup`, `recover`,
`rotateAuthority`, `rotateAdmin` реализуют соответствующие переходы; `publicState` выдаёт immutable public view.
Response Buffer скопирован, mutable caller bytes не меняют сохранённый snapshot.
Новые API входят только в source; installer/product runtime ещё не получает authority.

## Recovery и граница R2b

Backup не содержит ни root/admin/device private key, ни jobs, ни provider tokens.
Отдельный checkpoint `{digest,epoch,sequence,revision,issuedAt}` закрепляет владелец вне backup;
production host обязан атомарно сохранять последний high-water в nonrollback store при записи.
Конструктор с recoveryFloor не выдаёт документов до owner-signed recover точного backup.
Recovery оставляет revoked/decommissioned, переводит approved в pending и увеличивает epoch.
Без trusted current checkpoint restore запрещён; старый restore через fresh constructor
не является допустимым production restart. Этот host contract ещё требует квалификации.
Root rotation выдаёт snapshot новым ключом; новый pin/epoch распространяет владелец вне
untrusted payload. Старый pin не обновляется автоматически из сообщения authority.
Admin rotation требует двух подтверждений одного challenge старым и новым credential;
старый admin теряет права, root остаётся тем же, epoch/generation повышаются.

`verify(kind,bytes,pin)` проверяет подлинность и структуру, но не разрешает gated request:
R2b обязан добавить trusted epoch/sequence cache, проверку cert/snapshot/clock/possession,
nonce/idempotency и fence в request и commit, push/poll <=30 s, stale bound <=65 s.
Connector дополнительно проверяет собственные feature grants. Реального SLA uptime, TLS/mTLS,
TPM/store и push/poll в офлайн mock нет; работа ПК владельца и farm не inputs state machine.

## Change log

- 0.1 — 2026-11-06
