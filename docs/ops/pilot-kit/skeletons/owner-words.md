# Журнал owner-words проекта (DERIVED, пустой каркас pilot-install)

- Что это: производный реестр уже данных слов владельца по правилу `docs/ops/OWNER-WORDS-JOURNAL.md`. Журнал НЕ источник правды, НЕ Evidence и НЕ вход гейта. Источник правды каждого слова — запись в `docs/ops/OWNER-ADDENDA.md`; при расхождении выигрывает Addendum, строка не переписывается — добавляется корректирующая.
- Append-only: строка не правится и не удаляется; `void` фиксируется новой строкой со ссылкой на старую.
- Форма строки: fenced-блок с меткой record и девятью полями (`word-id`, `date-utc`, `owner`, `provenance`, `binding`, `scope`, `excluded`, `addendum-ref`, `links`); `status` (given / used / void) — метаданные строки ВНЕ блока. Образец и порядок добавления: `docs/ops/PILOT-L4-L6.md`, раздел L5.
- Проверки: `node .ai/bin/protocol-core.cjs artifact-lint docs/ops/owner-words.md` (advisory) и CM-71 в `node .ai/bin/protocol-validate.cjs --root .` (advisory, только WARN). Ни одна не заменяет ручную проверку правила 20 перед посадкой.
- Слово пишет только владелец; агент-автор строку «от имени владельца» не создаёт. Журнал пуст: ни одного слова ещё не записано.
