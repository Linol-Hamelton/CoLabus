# Operator candidates

Живой реестр — этот файл, `.ai/runtime/CANDIDATES.md` главного checkout проекта. Он не отслеживается Git (каталог `.ai/runtime/` в `.gitignore` протокола), поэтому `pilot-install` создаёт его только если файла нет и никогда не перезаписывает. Правила и формат строки: `docs/ops/CANDIDATES-TEMPLATE.md`; проверка: `node docs/ops/ops-guard.cjs candidates --tips`.

Пока в таблице нет живых строк, `launch-wrapper run` без `--no-gate` отказывает (`LAUNCH REFUSED by the gate`, exit 3): шлюз требует живого кандидата потока. Зарегистрируйте строку (stream, branch, полный sha из `git rev-parse`, owner, status `ready`) или запускайте с `--no-gate`.

| stream | branch | sha | owner | status | updated | note |
|---|---|---|---|---|---|---|
