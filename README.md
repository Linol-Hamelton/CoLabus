# CoLabus — ядро совместной работы ИИ-агентов в вашем проекте

Проект-хозяин (host project) — это проект, над которым вы работаете.
Ядро CoLabus — инструмент, а не предмет работы.
Разработка самого ядра ведётся в репозитории разработки, не здесь.

Версия ядра: 2.0.0 (точная сборка — в `PRODUCT-VERSION.json`). Этот репозиторий — продукт: его собирает скрипт
из репозитория разработки по списку разрешённого, руками он не правится, история у каждой сборки чистая.

Первый запуск: [одна страница с пятью командами](docs/product/QUICKSTART.md).

### Версия и дата сборки

В `PRODUCT-VERSION.json` поле `builtAt` — дата коммита-источника (`sourceSha`, время committer в UTC),
а не время запуска сборщика и не показание часов пользователя. Сборка детерминирована:
один исходный коммит и один манифест дают одну дату; несовпадение с местными часами не означает ошибку.

Версия **2.0.0** выпускается по минимуму: действующие записи L0–L9 по актам, строгие ссылки и LCC,
решения по пакетам, зелёный полный прогон. Дальнейшие улучшения ведутся отдельным этапом.

## Что это

Несколько ИИ-ассистентов (Claude, Codex, Copilot, DeepSeek, GLM, Mistral, Qwen и другие) работают в одном
репозитории, не видя переписки друг друга. Единственный общий канал — файлы. Ядро задаёт, где что лежит и как
передаётся работа:

| Что | Где в проекте после установки |
| --- | --- |
| правила протокола для всех агентов | блок ядра в начале `AGENTS.md` |
| текущая задача и открытые вопросы | `.ai/TASK.md` |
| предлагаемый подход | `.ai/PLAN.md` |
| утверждённые решения (только дописываются) | `.ai/DECISIONS.md` |
| журнал каждой сессии | `.ai/worklog/` |
| рабочие слои ядра (процедуры, роли, схемы) | `.ai/core/` |
| инструменты: проверка, замок, передача, сессии | `.ai/bin/` |
| хуки Claude и Codex | `.claude/`, `.codex/` |

## Как установить в проект

Нужны Node.js 22 и git. Проект должен быть git-репозиторием без незакоммиченных изменений в отслеживаемых файлах.

```powershell
git clone <адрес этого репозитория> CoLabus
node CoLabus/docs/ops/kernel-install.cjs --target <путь к вашему проекту> --dry-run   # что будет сделано
node CoLabus/docs/ops/kernel-install.cjs --target <путь к вашему проекту>
```

Установщик ставит инструменты и слои ядра, создаёт недостающие файлы состояния `.ai/` (существующие не трогает),
дописывает свои строки в `.gitignore` и `.gitattributes` и вставляет блок ядра в начало `AGENTS.md` и `CLAUDE.md`
проекта. Ваш текст в этих файлах остаётся байт в байт после блока. Затем он запускает проверку и линт ядра в проекте
и печатает итог. Он ничего не коммитит и ничего не отправляет: посмотрите `git diff` и закоммитьте сами.

Набор пилота (слои L4–L6: обёртка запусков, сводка состояния, статистика запусков, мастер ключей) ставится вторым
шагом на отдельную ветку `kernel-pilot-*`:

```powershell
node CoLabus/docs/ops/pilot-install.cjs --target <путь к вашему проекту> --dry-run
node CoLabus/docs/ops/pilot-install.cjs --target <путь к вашему проекту> --keys=ask
```

Контракт этого установщика — `docs/ops/PILOT-INSTALL.md`; что делать после него — `docs/ops/PILOT-NEXT-STEPS.md`.

## Как работать

Каталоги `docs/ops/channels-catalog.json`, `docs/ops/mcp-catalog.json` и
`docs/ops/model-ladder.json` поставляются без проверенных записей проекта.
Перед настройкой подключений и рекомендаций заполните их собственными проверенными
данными. Пустой каталог не подтверждает наличие доступов или инструментов;
маршрут запуска модели задаётся явно. Схемы и проверки находятся в соответствующих
инструментах `docs/ops/`. Ядро и установщики не требуют заполненных каталогов.

Агенты читают `AGENTS.md` (Claude — через `CLAUDE.md`) и `.ai/TASK.md` в начале каждой сессии. Задачу ставит
владелец проекта. Как пользоваться слоями ядра и ежедневными командами — `docs/product/OPERATING.md`; руководство
оператора — `.ai/docs/PROTOCOL.md`; заметки по отдельным клиентам — `.ai/docs/`.

Проверка перед передачей работы, в корне вашего проекта:

```powershell
node .ai/bin/protocol-validate.cjs --root .
```

## Как обновить

```powershell
git -C CoLabus pull
node CoLabus/docs/ops/kernel-install.cjs --target <путь к вашему проекту> --update
```

`--update` заменяет управляемые файлы ядра новыми (старые копии — в `.ai/backups/`), обновляет блок ядра в
`AGENTS.md` и `CLAUDE.md` и не трогает состояние проекта. Набор пилота обновляется командой
`node CoLabus/docs/ops/pilot-install.cjs --target <путь> --update` на ветке `kernel-pilot-*`.

## Что внутри этого репозитория

- `.ai/core/` — слои ядра; `.ai/bin/` — инструменты; `.ai/docs/` — документация для операторов;
- `docs/ops/kernel-install.cjs`, `docs/ops/pilot-install.cjs`, `docs/ops/pilot-kit.json` — установщики и набор пилота;
- `docs/ops/fleet/fleet.cjs` — инструмент для нескольких проектов на одной машине (`docs/product/OPERATING.md`);
- `templates/` — нейтральные шаблоны файлов состояния, обзора и промпта;
- `docs/product/RULES-IN-FORCE.md` — расшифровка идентификаторов решений, на которые ссылаются файлы ядра;
- `tests/` — тесты инструментов, которые запускаются в этом дереве: `node .ai/bin/protocol-test.cjs --root .`.

## Атрибуция (русский текст владельца)

**CoLabus** — продукт компании Labus.
Создан в 2026 году Русланом Фоменко (Ruslan Fomenko), инженером и учёным, для развития технологий генеративных моделей и повышения качества и проверяемости их работы. Руководитель рекламной кампании Labus.
Контакты: Telegram [@Fomenko_Ruslan](https://t.me/Fomenko_Ruslan) · e-mail fruslanj@gmail.com · Instagram @profit.generator
Первоисточник идеи и технологии: Colabs.

## Attribution (English line)

**CoLabus** is a product of the company Labus. Created in 2026 by Ruslan Fomenko, an engineer and scientist, to advance generative-model technologies and make their work better and verifiable. Head of the Labus advertising campaign. Contacts: Telegram @Fomenko_Ruslan (https://t.me/Fomenko_Ruslan), e-mail fruslanj@gmail.com, Instagram @profit.generator. Original idea and technology: Colabs.
