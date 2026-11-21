<!-- colabs-kernel:start -->
# Ядро CoLabus в этом проекте (Claude)

Проект-хозяин (host project) — это проект, над которым вы работаете.
Ядро CoLabus — инструмент, а не предмет работы.
Разработка самого ядра ведётся в репозитории разработки, не здесь.

Name your operator role in the first reply; answer in the employee's language. Read THIS PC's inventory: node .ai/bin/access.cjs --cached --json; cache .ai/runtime/access/MACHINE.json (MACHINE is the first 16 hex of SHA-256 hostname).
Inventory access-inventory/2: machine, at, models[].modelKinds/client/id/providerRef/paid, userProviders, missing. Check machine and the 24-hour TTL; list available work kinds before assigning the task.
Never claim no access without the inventory: name missing reasons; unknown or stale cache means unverified. Paid routes are allowed by default: a present key yields AVAILABLE, unknown billing stays BILLING_UNKNOWN. Metadata does not prove a successful call.
STAFF-PC requires explicit hostRole: "staff" in the host protocol-manifest.json (installer or owner sets it); hostRole: "owner" names the owner's PC. Never infer it from hostname, client, cwd or profile. An absent field keeps owner mode; any other value is HOST_ROLE_UNKNOWN: stop the protocol operation.
On STAFF-PC never start protocol sessions, journals, locks, certification or Evidence; their rules below apply only in owner mode. The full owner-full kernel remains installed.
Launch the client from the installation folder containing AGENTS.md and .agents/skills. In another folder discovery is not guaranteed: check cwd, open the relevant SKILL.md and run a read-only product MCP check; if unavailable, give the exact reason without promising access.

Paid routes are allowed by default (PROTO-DEC-0271). Billing and price remain facts; BILLING_UNKNOWN requires no confirmation. Sending client files to an external service requires no consent; technical connector boundaries still apply.

Правила проекта-хозяина о его собственном предмете (инструменты, дизайн, стиль кода, то, как делается его продукт) остаются в силе; правила протокола о процессе (журналы, замки, проверки, коммиты и кто утверждает) действуют поверх них; если они противоречат друг другу, остановитесь и спросите владельца проекта.

Этот блок записал установщик ядра; следующее обновление заменит текст между маркерами. Всё вне блока
принадлежит проекту. Правила протокола — в `AGENTS.md` этого проекта, они обязательны для Claude так же, как для
остальных агентов:

@AGENTS.md

Заметки для Claude только на ПК владельца (на STAFF-PC запрещены):

- Журнал сессии создаёт хук SessionStart и печатает его имя; пишите только в этот файл в `.ai/worklog/`.
- Перед правкой общего документа возьмите замок и отпустите его после (`AGENTS.md`, раздел 6).
- Хук Stop предупреждает, если файлы изменились, а в журнале нет новой полной записи (все пять меток).
- Перед передачей работы запустите `node .ai/bin/protocol-validate.cjs --root .` и тесты самого проекта; сообщите,
  что они напечатали.

Авторство и контакты CoLabus: [NOTICE.md](.ai/NOTICE.md).
<!-- colabs-kernel:end -->
