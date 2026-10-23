# Candidate registry (template and rules)

The LIVE registry is the file `.ai/runtime/CANDIDATES.md` of the MAIN checkout (untracked on purpose: it changes with every SHA, and a tracked file
edited in the main tree during a suite run would trip the leak detector). Every worktree finds it through `git rev-parse --git-common-dir`, so a
session in any worktree sees the same table. If the runtime directory is ever cleaned, recreate the file from the sample below and bring the rows up to date.
Claims live beside it in `.ai/runtime/claims.json` (written only by `ops-guard claim` and `release`).

## What a row means
One row per (stream, branch, SHA). A stream is one line of work with ONE live candidate at a time (for example `packet-compiler`, `wiring`).
Columns: `stream | branch | sha | owner | status | updated | note`.
Status: `building` (the author is still changing it), `ready` (author gate done, waiting for certifiers), `certifying`, `certified`, `landed`, `retired` (landed tree archived with hashes and removed through the retirement tool and ops-guard), `void` (stopped
or contradicting an owner decision; must never be certified or merged), `superseded` (replaced by a newer SHA of the same stream).
`void` and `superseded` rows are never deleted: they are how a stale pin is caught.

## Rules
1. Whoever changes a candidate updates its row in the same minute: the old SHA becomes `superseded`, the new one `ready`. Only one live row per stream (`candidates` fails otherwise).
2. Launcher и prompt проверяются по решению PROTO-DEC-0210: HTML запрещён во всём файле с причиной `PIN_HTML_REFUSED`; HTML не декодируется и не моделируется. SHA копируется из таблицы. Перед запуском выполняется `ops-guard launch-gate --stream S --owner O <launcher> <prompt>`: валидный реестр, точная вершина ветки S или detached commit, live claim владельца и проверки обоих файлов ниже. Проверяются декодированный исходный текст и одно Markdown-представление; сохраняются skeleton, wildcard и longest-live precedence. Для SHA нужны восемь точных позиций из десяти, для ветки допускаются не более двух неизвестных позиций; короткие ветки остаются на exact-token правиле.
3. `*_DONE` and `*_BLOCKED` markers are accepted only from the branch and SHA of the live row. A marker from any other branch is information, not a result.
4. Before a session or certifier is launched on a stream or worktree: `ops-guard claim --stream S --owner O --worktree W --ttl 120`. A refusal means somebody is already working there: ask, wait or let the claim expire; never start a second session on the same stream. `release` when the work ends.
5. When a candidate is stopped by order, mark it `void` FIRST, then kill the processes, then tell the streams. A stopped session may still commit; the registry, not the process list, decides what counts.
6. At the end of a stream, copy the table rows of that stream into the operator journal (history); the live file may be pruned.

## Проверка перед запуском и повтор после отказа (D1)

`launch-gate --stream S` блокирует устаревший SHA собственного потока S. Устаревший
SHA другого live-потока выводится как `WARN ... STALE`, не запрещая запуск S.
`candidates --tips` по-прежнему проверяет все потоки и возвращает отказ при любом
устаревшем SHA. Правило 1 об обновлении строки остаётся в силе.
Ошибки структуры всего реестра, несколько live-кандидатов, cross-machine collision,
неизвестный commit и отсутствующая ветка остаются причинами отказа launch-gate.
Если колонка branch равна полному 40-значному SHA этой же строки, кандидат detached:
проверяется существование именно этого commit, подвижной вершины ветки у него нет.
Сокращённый SHA или другой полный SHA в branch не задаёт detached-кандидата.
Любое другое значение branch определяется только как `refs/heads/<branch>` с точным совпадением имени: тег или
ветка другого регистра с тем же именем не подменяют ветку. SHA в строках реестра — ровно 40
строчных hex-цифр; в launcher и prompt токен SHA — 7 и более hex-цифр в любом регистре,
сравнивается в нижнем регистре, и сокращённая или более длинная форма void/superseded SHA
отказывает так же, как полная.
Launcher и prompt читаются как байты через общий text-safe: BOM, не-UTF-8 (в том числе UTF-16),
NUL, lone CR, перечисленные в `text-safe.cjs` невидимые классы (NBSP, ZERO_WIDTH, BIDI,
CONTROL, SEPARATOR, TAG, FILLER) и остальные Unicode format-символы (`Cf`) отказывают файл.
CRLF нормализуется. Combining marks (`M`) обрабатываются skeleton, общий запрет смешанных
письменностей снят: русский текст, `П-29` и `версия2` сами по себе проходят.

Первый слой после NFKC ищет целые SHA-токены 7+ hex и токены веток из ASCII-букв,
цифр, `.`, `_`, `/`, `-`, без учёта регистра, с `origin/`, `refs/heads/`, после `=` и перед точкой.
Второй слой следует правилам D1–D3:
**D1.** Любой HTML отказывает весь файл, даже без исторического имени: символ U+003C,
за которым непосредственно следует ASCII-буква, slash, восклицательный или вопросительный знак;
символ U+0026 перед #, перед ASCII alnum-именем с точкой с запятой (включая неизвестное имя)
или перед одним из 106 case-sensitive legacy HTML-имён, в том числе без точки с запятой
и перед продолжением буквами, цифрами или equals. Это включает tags, comments, declarations,
processing instructions, CDATA, незакрытую разметку, numeric decimal/hex references.
Разметка внутри code spans/fences и escaped HTML тоже отказывают; это правило всего файла.
Обычные символы в `a < b`, `c > d`, `R&D`, `A & B` проходят. Пробел между символом
U+003C и буквой не начинает HTML. Диагностика: `PIN_HTML_REFUSED`.
**D2.** HTML references не декодируются. Декодируются только прежние percent-байты ASCII
alnum или `-./_`, Markdown backslash escapes и markers emphasis/code spans (`*`, backtick);
`_` удаляется skeleton как пунктуация. Максимум восемь раундов, иначе `PIN_DECODE_DEPTH`.
HTML проверяется до декодирования и повторно после него: escaped/разбитые markers references
не обходят отказ. Без HTML остаются ровно два представления: SOURCE (декодированный исходный
текст) и MARKDOWN. Единственная Markdown-политика удаляет syntax links/images, destination,
reference annotation и definition lines, сохраняя label/alt text; исходное представление
сохраняет destination и definitions. Inline nested parentheses и reference links поддержаны.
Незакрытая конструкция остаётся текстом и не мешает следующим корректным links/images.
**D3.** Оба представления проверяются существующими skeleton и precedence; unsheltered
совпадение в любом отказывает. HTML renderer, семейства rendered views и entity table удалены.
Совпадающие финальные skeleton допускают дедупликацию в production; оценка ниже консервативно
считает оба, включая дубликаты. JS/CSS/DOM не исполняются.
Skeleton всего представления и каждого имени: сначала separator folds, затем NFKD, удалить M, `PIN_FOLDS`,
нижний регистр. Оставшиеся L/N/S вне `[0-9a-z]` превращаются в `?`, а Z/P/C удаляются.
Separator folds используют полный производный набор Unicode UTS #39 18.0.0: 102 записи,
чей рекурсивный prototype состоит только из `-`, `.`, `/`, `_`, включая их последовательности.
Два явных policy aliases для представителей групп: middle dot U+00B7 → `.`,
длинный штрих U+30FC → `-`; все члены этих групп выбираются из закреплённого confusables.txt.
Источник, версия, upstream SHA-256 и hash characters записаны в lib/pin-separators.json;
воспроизводимый генератор — pin-separators-build.cjs. Сохраняются варианты регистра.
Это сохраняет выравнивание для U+2212, U+2796, U+2215, U+2044, U+22C5, U+30FC, U+2500; символы-разделители
удаляются вместе с обычной пунктуацией, а не занимают wildcard-позицию.
NFKD сводит full-width и математические буквы/цифры к ASCII. Полная таблица букв UTS #39 не вводится:
неизвестные буквы используют wildcard, включая U+0251/U+0131/U+0237/U+03C3/U+0561.
Первые **10** знаков исторического SHA совпадают при **8+** точных позициях и **не более 2** `?`.
Полный skeleton ветки **6+** совпадает при не более двух `?`, остальные позиции точные.
Известная неверная ASCII-буква не wildcard. Для более коротких веток действует только первый слой:
например, одетый `a<U+E000>bc` не считается короткой веткой `abc`. Проверяются все остальные
строки потока, включая void/superseded и landed. Разделители и пробелы удаляются:
фраза `cand old` (как и `c a n d o l d`) склеивается в skeleton исторической `cand-old`
и отказывает. Это намеренный ложный отказ даже для обычной фразы. Пунктуация и переносы
тоже могут склеить совпадение через границу слов; `cand-old-extra` также отказывает.

Совпадение исторического имени игнорируется только внутри более длинного совпадения live-имени
того же вида. Обратное вложение отказывает; равные skeleton разных имён тоже отказывают.
Для токенов веток путь под live-веткой покрывается её именем, длина сравнивается по самому имени:
при live `cand` историческая `cand/old` отказывает; при live `cand-new` путь `cand-new/x`
не считается исторической веткой `x`. Отдельное вхождение `x` вне пути отказывает.
Live-совпадения допускают те же две wildcard-позиции. Само live-имя/тот же SHA в исторической
строке не запрещается. Отсутствие целого live SHA в исходном токенном слое — WARN.

Для Wq окон с q wildcard (q=0..2), остальные позиции hex, и V случайных исторических SHA:
union bound `V*(W0/16^10 + W1/16^9 + W2/16^8)`. Wq суммируются по двум представлениям
каждого файла, включая одинаковые skeleton. Воспроизводимое измерение:
helper исходного репозитория; 12 реальных абзацев, 24 views, 14 distinct skeleton,
15830 окон, Wq=[274,29,17], исключено 15510; bound(V=100)=4.6293280320242047e-7.
Это модель независимых равномерных исторических SHA, а не эмпирическая частота отказа.
Окно русской прозы с тремя `?` или известной не-hex буквой не может совпасть с SHA.
Для естественного текста и веток вероятностной гарантии нет; реальные русские абзацы
из документации проходят тесты рядом с live pin.
Совпадение 10-знакового префикса двух SHA внутри полного live SHA прикрывается live-совпадением;
отдельный одетый префикс отказывает. Это выбранный компромисс против обходов разрывом текста.
Каталог вместо pin-файла даёт `PIN_NOT_FILE`, ошибка чтения — `PIN_READ_REFUSED`.

Gate только читает claims: успешная или неудачная проверка не освобождает claim.
Исправьте собственную строку и pins и повторите gate, пока claim ещё жив.
Если claim отсутствует или истёк, диагностика печатает команду `claim` с теми же
stream, owner, repo, registry и claims; `--machine` и `--now` повторяются только если они были заданы
гейту, иначе берутся значения по умолчанию команды `claim`; выполните её из checkout инструмента
и повторите gate. При необходимости добавьте исходные `--worktree W --ttl MIN`.
Чужой live claim не перехватывать: дождаться освобождения или решения владельца.
`launch-wrapper` освобождает взятый claim после отказа своего gate; повторный запуск
wrapper снова берёт claim сам. Для прямого gate после такого отказа сначала нужен
`claim`, как указано в диагностике.

## Sample (recreate the runtime file from this form if it is lost)

| stream | branch | sha | owner | status | updated | note |
|---|---|---|---|---|---|---|
| example-stream | example-branch | 1111111 | <journal owner name> | superseded | 2026-01-01 | an older SHA of the stream |
| example-stream | example-branch | 2222222 | <journal owner name> | ready | 2026-01-01 | the one live candidate of the stream |

Tools: `node docs/ops/ops-guard.cjs candidates --tips | pin-check | claim | release | status | launch-gate | register` (its tests live in the source repository).
