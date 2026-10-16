# Пилот: L4, L5 и L6 в установленном проекте (контракт и инструкция)

Этот файл ставит `docs/ops/pilot-install.cjs` (kit v2, группы `l4`, `l5`, `l6` из `docs/ops/pilot-kit.json`) в `docs/ops/PILOT-L4-L6.md` проекта. Он описывает, что делает каждый слой В ПРОЕКТЕ, точные команды, переключатели, пределы и откат. Установка и отказы R1–R11: `docs/ops/PILOT-INSTALL.md`. Слой — это инструмент и данные проекта; решения, визы и слова владельца он не заменяет.

Правило проверки: слой назван «активным» только после того, как его activity-тест прошёл на установленной копии проекта (`node --test ` в источнике; результат на клонах пилотных репозиториев —  источника).

## 1. Что устанавливается и куда

Каждый корневой файл слоя копируется ВМЕСТЕ с замыканием его относительных `require()` на тот же путь, что и в источнике (`.ai/bin/*` лежит там, где его ждёт код; остальное — под `docs/ops/` и `docs/product/launch-records/` с путями источника, поэтому относительные `require` работают без правок). Файл ставится один раз — первой группой, назвавшей его. `docs/ops/pilot-kit/KIT-MANIFEST.json` хранит sha256 каждого файла (`layers[].files`), SHA источника и список «pending» (необязательные корни, которых нет в источнике).

| слой | что делает в проекте | основные файлы |
|---|---|---|
| L4 | запуск агентов проекта под единым наблюдателем: маркеры, running/terminal-записи, правило живости (idle/hard), lease с идентичностью процесса, packet ядра для reviewer/certifier, шлюз реестра кандидатов, CLI диспетчера | `.ai/bin/protocol-dispatch.cjs` + `protocol-dispatch/*`, `protocol-runrecord.cjs`, `protocol-signals.cjs`, `docs/ops/launch-wrapper.cjs`, `launch-packet.cjs`, `cert-launch.cjs`, `fix-launch.cjs`, `ops-guard.cjs`, `repo-paths.cjs`, `launch-record.cjs`, `served-model.cjs` |
| L5 | краткая сводка состояния для владельца и оператора, журнал слов владельца, форма карточки | `docs/ops/state-brief.cjs`, `OWNER-WORDS-JOURNAL.md`, `OWNER-CARD-FORM.md`, каркасы `owner-words.md`, `OWNER-ADDENDA.md`, `pilot-profile.json`, `launches/LAUNCHES.jsonl` |
| L6 | статистика запусков, заполненность полей, дозаполнение по evidence, проверка записи, проверка места сертификатора | `docs/product/launch-records/tools/launch-stats.cjs`, `launch-fill.cjs`, `launch-record-backfill.cjs`, `launch-record-validate.cjs`, `docs/ops/seat-check.cjs`, `LAUNCH-RECORD-EXT.md` |

Каркасы (`skeletons`) пишутся ТОЛЬКО если файла нет и никогда не перезаписываются: журнал, реестр и профиль проекта принадлежат проекту. Файл проекта на пути, который занимает файл kit, `pilot-install` НЕ перезаписывает: отказ R11 до любой записи. Прежние файлы kit с локальными правками заменяются после копии в snapshot.

Старый минимальный набор (`docs/ops/pilot-kit/run-and-record.cjs`, журнал ) остаётся как был: для запуска одной команды с одной записью без шлюзов.

Kit v3 () добавляет к тому же набору, под `docs/ops/pilot-kit/src/docs/ops/`, обязательный минимум MCP (`mcp-schema-budget.cjs`, `mcp-recommender.cjs`, `mcp-catalog.json`, `MCP-REQUIRED-AND-OPTIONAL.md`, скилл подборщика) и набор каналов и ключей (`channels-doctor.cjs`, `channels-keys.cjs`, `channels-env.cjs`, `channels-dedupe.cjs`, `channels-guard.cjs`, `channels-catalog.json`, `CHANNELS.md`, скилл онбординга); в проект также попадают `docs/ops/PILOT-NEXT-STEPS.md` (чек-лист пользователя) и `docs/ops/pilot-kit/pre-push-guard.sample`. Подробно в разделе 9.

### Откуда берутся пути

Инструменты не содержат путей машины. Runtime (`.ai/runtime`) и буфер записей запусков берутся от ГЛАВНОГО checkout git-репозитория, в котором лежат файлы (`git rev-parse --git-common-dir`), как это делают `launch-wrapper` и `ops-guard`; переопределения окружением: `OPS_RUNTIME_DIR`, `OPS_LAUNCH_PENDING_DIR`. Каталог worktree для cube-блока `state-brief` — соседний `<имя главного checkout>WT`, переопределение `STATE_BRIEF_CUBE_DIR`. В репозитории разработки те же формулы дают прежние пути байт в байт (тест ).

## 2. Установка, повторная установка, откат

```
node docs/ops/pilot-install.cjs --target <repo> --dry-run
node docs/ops/pilot-install.cjs --target <repo> [--branch kernel-pilot-YYYYMMDD]
```

`--dry-run` ничего не пишет и печатает по слоям, что будет создано (`(new)`), оставлено (`would be kept`) или заменено. Повторный запуск на второй ветке идемпотентен: `KIT-MANIFEST.json` тот же байт в байт, дублей файлов нет, журнал и реестр проекта не тронуты, второй коммит отличается от первого только `docs/ops/pilot-install-report.md`.

Откат: `git checkout <прежняя ветка>`; ветку пилота удаляет только владелец (`git branch -D kernel-pilot-...`). Kit не лежит нигде вне репозитория, кроме snapshot в временном каталоге ОС и `.ai/runtime/CANDIDATES.md` (git-игнорируется).

## 3. L4: запуск агента проекта

### 3.1 Команда по умолчанию: wrapper + engine dispatch, packet только для reviewer/certifier/auditor

Предусловие: проект создаёт свой `.ai/docs/clients.json` (`clients/1`) и проверяет записи запускаемых клиентов по их локальному help/version (P-L3-005). Без этого cert/fix-путь недоступен: `EFFORT REFUSED`, exit 2, до старта клиента. Установка не копирует реестр разработки и не разрешает обход отказа. Для непосредственной команды без этих запускателей доступен `run-and-record.cjs`.

```
set OPERATOR_PACKET=certifier,reviewer,auditor
node docs/ops/launch-wrapper.cjs run --stream <поток> --owner <кто> --name <имя> --worktree <рабочий каталог> --engine dispatch [--no-gate] [--certifier] [--stall-seconds N] [--hard-seconds N] [--pin-files <запускатель>,<промпт>] -- node <абсолютный путь>/docs/ops/cert-launch.cjs --client codex --model <модель> --worktree <рабочий каталог> --name <имя-внутри> --prompt-file <промпт> --expect-sha <короткий sha HEAD рабочего каталога> --packet-role certifier --packet-stage accept --packet-profile 4
```

Что происходит:

- `launch-wrapper` берёт claim потока, запускает шлюз (если нет `--no-gate`), запускает команду через executor L4 в одноразовом scratch-каталоге (поэтому путь к `cert-launch.cjs` АБСОЛЮТНЫЙ: рабочий каталог команды не проект), следит за правилом живости и на ЛЮБОМ выходе пишет терминальный маркер в `.ai/runtime/<имя>.marker.txt` (`<имя>_DONE exit=0 end=…` или `<имя>_FAILED exit=N class=C end=…`), `<имя>.running.json` (с pid корня движка и временем конца) и `<имя>.terminal.json` (статус, код выхода, класс, последние 20 строк). Код выхода wrapper — код выхода агента; убитый правилом живости ребёнок даёт `FAILED`, `exit=none`, класс `STALL` (или `INTERRUPTED` для hard-потолка) и код 1.
- Lease: `.ai/runtime/dispatch-wrapper/lw-<имя>.lease.json` хранит запись попытки (PID + время создания процесса корня, дети, `settled`). Время создания записано, если процесс прожил достаточно долго для замера (убитый правилом живости ребёнок — да; ребёнок, завершившийся за долю секунды, оставляет `createdAt: null` при `settled: true`). Незавершённая попытка (выживший процесс) блокирует следующий запуск того же имени.
- Живость: простой 10 минут без собственного вывода агента → `STALL`; потолок 120 минут; бюджет пробуждений 3. Короткий предел для проб или жёсткого проекта: `--stall-seconds N` и `--hard-seconds N` (только с `--engine dispatch`; по умолчанию не заданы; значения ≤ 0 и неЧисла — ошибка использования, exit 2, ничего не стартует).
- `--certifier` ставит `PROTOCOL_NO_FULL_SUITE=1` ребёнку; `LAUNCH_WRAPPER_NAME` ребёнок получает всегда.
- Без `--engine dispatch` работает прежний путь (прямой spawn), он остаётся умолчанием.

### 3.2 Packet ядра (переключатель `OPERATOR_PACKET`)

| значение | действие |
|---|---|
| не задано, пусто, `off` | packet не компилируется; запускатель работает как до интеграции (умолчание) |
| `on` | разрешены только роли `certifier,reviewer,auditor` |
| `certifier,reviewer` | разрешены только перечисленные |

С включённым переключателем и флагами `--packet-role R --packet-stage S [--packet-profile auto|1|2|3|4|full] [--packet-frame F]` `cert-launch.cjs`/`fix-launch.cjs` компилируют инструкцию из `.ai/core` ПРОЕКТА, кладут её в `<рабочий каталог>/.ai/runtime/launch-packets/<роль>-<стадия>-<tree8>-<hash8>.md`, добавляют ПЕРВОЙ строкой prompt `Read .ai/runtime/launch-packets/… first, it is your compiled instruction` и пишут в launch-record `packetHash`, `packetProfile`, `packetBytes`, `packetEstTokens` и фактические `role`/`stage`. Роли исполнителей (`implementer`, `fixer`, `drafter`, `synthesiser`) выключены: без `--allow-executor-packet` это отказ `PACKET REFUSED ...; nothing was started`, exit 3, клиент не запускается; ошибка компилятора при включённом переключателе даёт тот же отказ.

Откат: убрать `OPERATOR_PACKET` или поставить `off`. Файлы packet лежат только в git-игнорируемом `.ai/runtime`.

### 3.3 Шлюз и реестр кандидатов

`docs/ops/ops-guard.cjs` (`candidates --tips`, `claim`, `release`, `status`, `pin-check`, `launch-gate`) и пустой каркас `.ai/runtime/CANDIDATES.md`. Реестр не отслеживается git (каталог `.ai/runtime/` в `.gitignore` протокола), `pilot-install` создаёт его, если файла нет; формат и правила: `docs/ops/CANDIDATES-TEMPLATE.md`. Пока в таблице нет живой строки потока, `launch-wrapper run` БЕЗ `--no-gate` отказывает (`LAUNCH REFUSED by the gate; nothing was started`, exit 3, claim снят). Шлюз требует `--pin-files` с запускателем и промптом. Пока владелец не завёл кандидатов, запускайте с `--no-gate`: `ops-guard` тогда не участвует. Когда кандидат заведён (полный sha из `git rev-parse HEAD`, ветка из `git rev-parse --abbrev-ref HEAD`), шлюз проверяет реестр, совпадение вершины ветки, claim и «пины» в файлах.

### 3.4 CLI диспетчера (слоты, run-record)

`node .ai/bin/protocol-dispatch.cjs probe|check|run|status|report --registry <clients.json> <dispatch.json>`: файл клиентов проекта (`clients/1`, поле `command` с `{workdir}`, `{message}`, `{model}`) и файл слотов пишет проект; файлы разработки `.ai/docs/clients.json` (учётные данные и пути машины) и `docs/ops/model-ladder.json` НЕ ставятся. Успешный `run` дописывает `run-record/1` в `docs/ops/RUNS.jsonl` (или `PROTOCOL_RUNS_FILE`), состояние — в `<stateDir>/state.json`, сигнал падения — в `.ai/SIGNALS.md`.

## 4. L5: сводка состояния и журнал слов

### 4.1 state-brief

```
node docs/ops/state-brief.cjs --now 2026-10-08T12:00:00Z > brief.md
node .ai/bin/protocol-core.cjs artifact-lint brief.md
```

Выводит fenced-блок `brief` с конвертом `== state-brief <UTC> ==` и шестью полями (`tree`, `registry-open`, `launches`, `tasks`, `freshness`, `unknowns`), затем WARN-строки и человекочитаемый advisory-блок (если нет `--no-advisory`). Время в payload — только из `--now` или `STATE_BRIEF_NOW`. Требуемые источники: git, `.ai/runtime/CANDIDATES.md` и `docs/product/launch-records/launches/LAUNCHES.jsonl` (оба создаёт установка); без них — карточка STOP и exit 2, а не выдуманный ответ. Запланированные задачи проекта называет `docs/ops/pilot-profile.json` (`stateBrief.tasks`; пустой список — «задач нет», поле `tasks: none`); `--tasks-snapshot <файл>` и `--tasks a,b` перекрывают профиль.

### 4.2 Журнал owner-words и CM-71

Файлы: `docs/ops/owner-words.md` (производный журнал, пустой каркас), `docs/ops/OWNER-ADDENDA.md` (источник правды слов проекта), правило `docs/ops/OWNER-WORDS-JOURNAL.md`, форма карточки `docs/ops/OWNER-CARD-FORM.md`. Проверки: `node .ai/bin/protocol-core.cjs artifact-lint docs/ops/owner-words.md` и CM-71 в `node .ai/bin/protocol-validate.cjs --root .` (advisory, только WARN; пустой журнал: `inspected 0 owner words`).

Порядок добавления слова (журнал пишется ВТОРЫМ, слово владельца агент не сочиняет):

1. Слово владельца дословно записывается разделом `## Addendum N` в `docs/ops/OWNER-ADDENDA.md` (дата, цитата, провенанс, кто записал). Номер строки заголовка — якорь.
2. В конец `docs/ops/owner-words.md` добавляется строка (образец; значения — из реального слова):

````
### OW-20261008-01 - краткое название

- status: given

```record
word-id: OW-20261008-01
date-utc: 2026-10-08T12:00:00Z
owner: <имя владельца>
provenance: direct owner word; transcribed by <сессия> into docs/ops/OWNER-ADDENDA.md
binding: standing
scope: что именно покрывает слово
excluded: landing; activation; kernel schema; security paths
addendum-ref: docs/ops/OWNER-ADDENDA.md:<номер строки раздела>
links: docs/ops/OWNER-ADDENDA.md
```
````

3. Коммит (CM-71 предупреждает, если журнал не отслеживается git). `binding: candidate` требует `<ветка>@<полный 40-hex sha из реестра>`, `plan` — `<sha256>@<commit>`.

Ожидаемо после шага 3: `artifact-lint` — `findings=0 ... records=1`; CM-71 — `inspected 1 owner words ... malformed=0`. Журнал не источник правды, не Evidence и не вход гейта; ручная проверка правила 20 перед посадкой остаётся.

## 5. L6: записи запусков и статистика

Запись `launch-record/1` пишут запускатели (`cert-launch.cjs`, `fix-launch.cjs`) в буфер `docs/product/launch-records/launches/pending/launches-YYYYMMDD.jsonl` (git-игнорируется протоколом), а минимальный `docs/ops/pilot-kit/run-and-record.cjs` — в . Сам `launch-wrapper` пишет маркеры и running/terminal-файлы (это evidence для дозаполнения), а не launch-record.

```
node docs/product/launch-records/tools/launch-record-validate.cjs check <файл.jsonl>
node docs/product/launch-records/tools/launch-stats.cjs report --include-pending [--by client|tuple|role|variant|packet] [--out launches/stats/STATS-<дата>.md]
node docs/product/launch-records/tools/launch-stats.cjs due --include-pending
node docs/product/launch-records/tools/launch-stats.cjs compare --by packet --include-pending
node docs/product/launch-records/tools/launch-fill.cjs report --include-pending
node docs/product/launch-records/tools/launch-fill.cjs backfill --include-pending --runtime .ai/runtime --repo . [--apply]
node docs/ops/seat-check.cjs --name <имя запуска>
```

Все они advisory (не Evidence, не вход гейта); `backfill` без `--apply` ничего не пишет, с `--apply` создаёт НОВЫЙ файл в `launches/backfill/`. `backfill` дозаполняет записи по evidence СТАРЫХ runtime-запускателей разработки (файлы-запускатели `<имя>-launch.*` рядом с call-файлами в `.ai/runtime`); запускатели `cert-launch`/`fix-launch` пишут полную запись сами, поэтому в проекте `backfill` честно печатает `sources=0 records=0` (нечего выводить) — это не ошибка.

Served model (какая модель реально ответила): `cert-launch`/`fix-launch` берут её из источника вне отчёта (codex — строка `model: <id>` в заголовке вывода, mimo — баннер `build · <model>` или лог сессии, dahl — `AGENT_RESULT`), печатают одну строку `SERVED model=… source=… match=yes|no|unknown` и пишут `servedModel`, `servedModelSource`, `servedModelConfidence` в запись. `seat-check` для места certifier/reviewer: exit 0 — модель совпала (или запуск не место сертификатора, поля только печатаются); exit 1 — модель не получена или отличается («место недействительно»); exit 2 — записи нет или вход непригоден. Для vibe, agy и текстового маршрута claude источника нет: `none`, это не доказательство модели.

## 6. Переключатели

| что | как включить | как выключить | по умолчанию |
|---|---|---|---|
| engine dispatch в wrapper | `--engine dispatch` | без флага или `--engine legacy` | выключен (legacy) |
| короткий idle/hard | `--stall-seconds N`, `--hard-seconds N` | не задавать | 10 мин / 120 мин |
| packet reviewer/certifier | `OPERATOR_PACKET=certifier,reviewer,auditor` или `on` | не задавать или `off` | выключен |
| packet для исполнителей | `--allow-executor-packet` И роль в `OPERATOR_PACKET` | не передавать | выключен |
| шлюз кандидатов | завести строку реестра и `--pin-files` | `--no-gate` | включён (отказ при пустом реестре) |
| runtime / буфер записей | `OPS_RUNTIME_DIR`, `OPS_LAUNCH_PENDING_DIR` | не задавать | `<главный checkout>/.ai/runtime`, `…/launches/pending` |
| задачи для state-brief | `docs/ops/pilot-profile.json` | править профиль | пустой список |
| served model | автоматически в запускателях | — | запись/печать, ничего не блокирует |

## 7. Известные пределы (честно)

1. `node .ai/bin/protocol-core.cjs verify --layer L0..L3` — ворота заморозки ИСТОЧНИКА. В установленном проекте оно завершается exit 1: записи ядра ссылаются на `PROTO-DEC-…`, которых нет в `.ai/DECISIONS.md` проекта (LCC-3), а также на записи не поставленных слоёв (LCC-2/5/9). Копия блоков решений закрыла бы только LCC-3, поэтому выбран меньший честный вариант: проект проверяется обычным `node .ai/bin/protocol-core.cjs verify` (exit 0) и `node .ai/bin/protocol-validate.cjs --root .`; тест  закрепляет и то и другое, включая сам отказ LCC-3.
2. Запускатели `cert-launch`/`fix-launch` стартуют клиентов через `cmd.exe /c <клиент> …` с фиксированными флагами (`codex`, `vibe`, `mimo`, `agy`, `dahl`; для `dahl` нужен `OPENAI_COMPAT_AGENT`, агент не ставится). Это Windows-путь; клиент другой формы запускается через `run-and-record.cjs` или через `protocol-dispatch.cjs` со своим `clients.json`.
3. Pulse-демон `launcher-heartbeat.cjs` — runtime-часть оператора и не ставится: при его отсутствии запускатель печатает `HEARTBEAT none: …` и идёт дальше; надзор даёт правило живости `--engine dispatch`.
4. Сам `launch-wrapper` не пишет `launch-record/1`; запись пишут запускатели. Прямая команда без запускателя оставляет только маркеры и running/terminal-файлы.
5. Команда под `--engine dispatch` стартует в scratch-каталоге: пути к запускателю и файлам — абсолютные. Packet компилируется из `.ai/core` рабочего каталога, переданного `--worktree`.
6. `.ai/runtime/CANDIDATES.md` не коммитится (runtime): после нового clone проекта реестр нужно завести заново; каркас создаст повторная установка.
7. Не ставятся: listener Telegram и keeper (`protocol-listener-*`), `model-ladder.json`, `clients.json` разработки, `PROCESS-REGISTER.md` и `ops-guard register`, `cert-ready`, calibration farm, report-gate, cube-слои. `state-brief` в проекте не знает запланированных задач и cube. Запускатели cert/fix недоступны до создания и проверки собственного `.ai/docs/clients.json` проекта (схема `clients/1`, P-L3-005). Отсутствующий или испорченный реестр, отсутствующий клиент и `present: false` дают отказ до старта (`EFFORT REFUSED`, exit 2); ни клиент, ни запись запуска не создаются. Пустой реестр — только пример схемы в источнике kit (), он не разрешает запуск. Packet-компилятор отдельно может использовать полный текст при неизвестной capability (PC-13), но это не отменяет стоп-условия запуска. Реестр разработки по-прежнему не ставится.
   Решение PILOT-FIX F3 (2026-10-15): `.ai/docs/clients.json` в замыкание НЕ входит. Группа `selection-operator` несёт `.ai/bin/lib/model-identity.cjs`, который раньше делал `require('../../docs/clients.json')` при загрузке и тянул реестр разработки в каждый проект; но реестр принадлежит проекту (P-L3-005), и поставляемая копия столкнулась бы с его собственным файлом (R11) и сняла бы отказ запускателей. Теперь модуль читает реестр с диска: файла нет (ENOENT) — launch-алиасов нет, алиасная запись модели остаётся `UNKNOWN`; файл есть, но не JSON или без объекта `clients` — отказ, не молчаливый пропуск; реестр проекта с `launchAliases` даёт свои алиасы. В репозитории разработки поведение прежнее. Тесты:  (`the real installed kit has no registry`, `F3:`).
8. Статистика осмысленна от десятков записей; до этого `launch-stats` печатает `n<5` вместо медианы. Все слои L5/L6 advisory.
9. Установленный в проект kit — снимок источника на SHA из `KIT-MANIFEST.json`. Обновление — повторный `pilot-install` на новой ветке.

## 8. Тесты

В источнике: `node --test     ` и `node --test `.  строит в временном каталоге ОС проект с настоящим установщиком и `pilot-install`, подставляет фальшивого агента и фальшивого клиента и проверяет: установку слоёв и манифест; загрузку каждого модуля; отсутствие путей разработки; здоровье проекта (validate, lint, verify); L4 (маркеры, lease, STALL по короткому пределу, шлюз, packet reviewer/certifier и выключенные исполнители, полную команду по умолчанию, `protocol-dispatch run` с `run-record/1`); L5 (state-brief + artifact-lint, журнал и CM-71); L6 (stats, fill, backfill, served model, seat-check); идемпотентность, `--dry-run`, R11; kit v3 (раздел 9): врач каналов с `--no-mcp` и подборщик запускаются из kit и не меняют файлов проекта. Для репетиции на копии настоящего проекта: `PILOT_BASE_DIR` (проект ДО установки) и `PILOT_TARGET_DIR` (он же ПОСЛЕ, ветка `kernel-pilot-l46`, копия во временном каталоге ОС); тесты работают на копиях этих каталогов. Дополнительно в источнике: `node --test   `.

## 9. Kit v3: обязательные MCP, каналы, чек-лист пользователя, защита публичного репозитория

Что делает `pilot-install` сверх разделов 1-8 (поведение ветки, отказы R1-R11, возврат блоков-маркеров и запрет push не менялись):

1. **Файлы.** В `docs/ops/pilot-kit/src/docs/ops/` лежат инструменты MCP и каналов (список в разделе 1); манифест `KIT-MANIFEST.json` перечисляет их с sha256, `pending` и `unresolved` пусты. Замыкание `require()` всего манифеста: 20 файлов (13 новых корней, `launch-record`, проверка записи, `served-model`, `seat-check` и то, что они подтягивают).
2. **Обязательный минимум MCP (PROTO-DEC-0170).** Врач каналов `node docs/ops/pilot-kit/src/docs/ops/channels-doctor.cjs --root . --network` всегда считает `serena`, `codebase-memory` и `qmd` нужными. Отсутствующий сервер он называет действием `[connect]`, неавторизованный `[authorize]`, упавший `[repair]` и печатает закреплённую версию и ТОЧНЫЙ фрагмент для клиента (Claude Code `.mcp.json`, Codex `~/.codex/config.toml`, Vibe `~/.vibe/config.toml`) из `MCP-REQUIRED-AND-OPTIONAL.md`, раздел 1.3 (`<NPM_GLOBAL>` подставляет пользователь). Врач и kit НЕ правят `.mcp.json` и клиентские конфигурации и не ставят серверы: они печатают список действий. Без `--network` `claude mcp list` не запускается, серверы показываются как `not-checked`; с `--no-mcp` листинги клиентов не читаются вообще. Сервер, найденный хотя бы в одном клиенте, считается подключённым.
3. **Чек-лист пользователя.** Установщик записывает `docs/ops/PILOT-NEXT-STEPS.md` и печатает его в конце: врач, вход в браузере, ключи через `channels-keys` (значение вводит пользователь, агенту не даётся), три обязательных сервера, подборщик и выбор дополнительных, строки `.gitignore` (печатаются, файл проекта не правится), повтор врача до пустого списка.
4. **Публичный репозиторий.** Ветка `kernel-pilot-*` держит ядро, журналы и записи запусков и НЕ должна попасть в публичный репозиторий (Fight-for-the-moon публичный, SiteMVP приватный). Каждый запуск, кроме отказа, заканчивается видимым блоком об этом; образец хука `docs/ops/pilot-kit/pre-push-guard.sample` пользователь ставит сам (`cp ... .git/hooks/pre-push`): он отказывает при push ссылки `kernel-pilot-*` или коммита, содержащего вершину такой ветки, пока не задано `ALLOW_KERNEL_PILOT_PUSH=1`. Пределы хука: `--no-verify`, cherry-pick, локальность клона.
5. **Пути в подсказках.** Врач и инструменты ключей печатают команды с путём, как его набирает пользователь: `docs/ops/pilot-kit/src/docs/ops/channels-keys.cjs` в проекте, `docs/ops/channels-keys.cjs` в репозитории ядра.
6. **Тесты не трогают живое состояние исходного checkout.**  снимает список файлов (имя, размер, mtime) в `.ai/runtime`, буфере `pending` и `docs/ops` главного checkout до набора и после него: набор падает, если новая или изменённая запись называет временные каталоги этого набора. Запись другой живой сессии его не задевает. Набор  сохраняет собственную, более строгую проверку.
