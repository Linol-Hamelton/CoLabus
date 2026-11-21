# Calling another agent from the terminal

Several assistants work in these repositories and they do not share chat history.
Most of them can be started directly from a terminal. This file is the contract for
that: who can be called, how, and what a call does and does not transfer.

It is a managed protocol document. The installer copies it into every project, so
the same rules hold in the protocol source repository and in every host project.

Read `AGENTS.md` first. Nothing here weakens it.

---

## 1. The roster

The table lists command forms. Verify availability and model IDs on the host before dispatch; use an explicit route. Do not invent a command.

| Command | Models | Non-interactive flag | Notes |
| --- | --- | --- | --- |
| `codex` | GPT-6 Astra and others | `codex exec` | `-s/--sandbox`, `-C/--cd`, `-m/--model`, `--ephemeral`, `-c key=value` |
| `claude` | Opus 5 and others | `-p` / `--print` | `--model`, `--add-dir`, `--permission-mode` |
| `copilot` | several, `--model auto` picks | `-p` / `--prompt` | `--reasoning-effort`, `--agent`, `--context`, `--fleet` |
| `vibe` | Mistral 2 models | `-p` / `--prompt` | `--max-turns`, `--max-price`, `--max-tokens`, `--workdir`, `--enabled-tools`; note: never edit an entry after `record`; add a new one |

`copilot --model auto` changes over time. Check the list rather than
hard-coding a model id in a script, and record the id you actually used.

### DeepSeek has no terminal client

There is no `deepseek` CLI on this workstation, and the obvious substitutions were
tested and failed for a measurable reason, not a configuration mistake:

- `codex` with `wire_api = "chat"` pointed at `https://api.deepseek.com/v1`:
  refused. Codex CLI 0.154.0 dropped the chat-completions wire protocol and accepts
  only `wire_api = "responses"`; DeepSeek's API is chat-completions.
- `codex` with `wire_api = "responses"` through OpenRouter (`deepseek/deepseek-chat`):
  authenticates and starts a session, then fails with `context_length_exceeded` -
  181,577 input tokens against the model's 163,840 limit, with `--ignore-user-config`
  already removing the local MCP stack. The Codex harness instructions alone exceed
  what a DeepSeek model can hold.

So DeepSeek participates through its IDE or chat interface, and its output reaches the
repository through the section 5.5 transcription fallback in `AGENTS.md`, marked
`[MODE: READ-ONLY ADVISORY]` unless the session itself ran `protocol-session.cjs start`
and produced its own receipt. Re-test when either a DeepSeek model ships a larger
context or a smaller harness is available; record the measurement, not an impression.

The verified per-client data is `.ai/docs/clients.json` (section 9); the table above is the 2026-09-22 snapshot.

---

## 2. A call is a dispatch, never a transfer of authority

Calling another agent hands over a task. It hands over nothing else.

- The called agent is bound by the same `AGENTS.md` and the same `.ai/DECISIONS.md`.
- A caller cannot grant an approval it does not have. An owner approval comes from the
  owner, and a proposal stays a proposal until then.
- A caller cannot authorise a callee to skip the completion gate, to mark
  `Status: Completed`, or to write a `PASS` it has not earned.
- A caller cannot widen the freeze, the forbidden paths or the scope of a task by
  writing a wider scope into the prompt.

If a prompt asks for something the protocol forbids, the called agent refuses that
part, does the rest, and records the refusal in its own journal.

---

## 3. The called agent owns its own session

Before doing any work, the called agent starts its own protocol session in the target
repository:

```bash
node .ai/bin/protocol-session.cjs start --agent <name>
```

That prints its context, its session id and one owner name. The callee uses that owner
name for its journal, its lock and its evidence.

- One journal per session. Nobody writes into another session's journal, and a caller
  never records a receipt for a callee.
- The caller does not hold the shared-document lock while a callee needs it. One writer
  at a time, whoever that writer is.
- If the callee changes the tree, it writes its own entry with all five labels and runs
  `protocol-handoff.cjs record --owner <its own owner name>`.

A call that runs in print mode inside another agent's terminal still produces a real
tree change when it edits files. Print mode is not a reason to skip the journal.

---

## 4. Terminal output is not evidence

What a callee prints into the caller's terminal is a claim. It is exactly as good as
prose in a journal, and it is not an Evidence block.

- Evidence is the callee's own journal entry plus its own `record` receipt.
- A result that exists only as stdout or in a chat panel is advisory. Persist it, if it
  matters, through the section 5.5 transcription fallback, with the header that
  fallback requires, and mark it non-certifying.
- Never paste a callee's claimed test result into your own entry as if you ran it. Name
  who ran it and link their receipt, or run it yourself.

---

## 5. Calling someone does not make you independent of them

Independence is a property of the work, not of the process boundary.

An agent that invokes another agent and writes its prompt has shaped and controlled
that work. By PROTO-DEC-0041 item 1 it may not then issue a `CERTIFYING` verdict on the
result. The certifier of a high-risk candidate stands outside both execution and
control, and a high-risk candidate needs two such reviewers working in parallel on the
same input package.

This is the rule most easily lost when dispatching becomes cheap. A caller can produce
five opinions in five minutes; none of them is an independent review of the caller's
own task.

---

## 6. Safe invocation

Default to the least privilege that still lets the task finish.

- Prefer a read-only or sandboxed run for anything that only needs to look:
  `codex exec -s read-only`, `vibe --enabled-tools <list>`.
- Do not pass `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
  `--allow-all-tools`, `--auto-approve` or `--yolo` unless the owner authorised that run.
  Record it in your entry when you do.
- Scope the workspace explicitly: `--add-dir`, `-C/--cd`, `--workdir`. A callee should
  not discover a second repository by accident.
- Bound the run where the CLI supports it: `vibe --max-turns --max-price --max-tokens`,
  `codex exec --ephemeral`.
- A seat started by `docs/ops/fix-launch.cjs` (claude), `docs/ops/cert-launch.cjs` (claude, codex, vibe) or the
  operator's `tools/operator/seats.cjs` (claude, codex) loads no MCP server of the user's configuration. An author,
  fixer or pre-review seat gets exactly the kernel servers qmd and codebase-memory (`.ai/bin/lib/seat-mcp.cjs`:
  claude `--strict-mcp-config --mcp-config FILE`, codex `-c mcp_servers...` on top of `--ignore-user-config` with the
  sandbox restated, vibe `--enabled-tools qmd_* codebase-memory_*`); a certifier or unknown seat gets none
  (PROTO-DEC-0170 item 4). Set `COLABUS_SEAT_MCP=1` (exactly `1`) for a task that needs the user's own servers; kilo,
  mimo and kimi have no documented per-run flag. `--ignore-user-config` also drops the codex `[projects]` trust
  and `[hooks.state]`, so a codex seat launched into a main checkout gets a WARN line (hooks will not run).
- `node .ai/bin/mcp-wiring.cjs doctor` reports per client whether qmd and codebase-memory are registered and
  reachable; `apply` adds the missing entries (a dry run unless `--apply`; backup first). The MCP call metric is
  not available in this release: `metric` prints one line that says so, reads nothing, prints no count and exits 0.
  All of it is advisory, never Evidence.
- Never put a key, token or password into a prompt or a command line. Keys live in
  environment variables; the handoff scanner blocks entries that carry them.
- Run the callee in the repository the task belongs to. A protocol session in one
  checkout does not commit in another.

---

## 7. What a dispatch prompt must carry

A dispatch that omits these produces a round of clarification instead of work:

1. The repository and the exact start command for the callee's own session.
2. The task, and what is explicitly out of scope.
3. Forbidden paths, and the baseline commit SHA the work starts from.
4. What counts as done, stated so it can be checked by running something.
5. Who reviews, and the reminder that the callee may not mark its own work Completed.
6. The closing steps: `git diff`, a five-label journal entry, then `record`, and report
   the exit codes it actually printed.

Для автора и сертификатора исходного ядра задание называет точный базовый commit.
Тяжёлые прогоны — операторские: полный набор, затронутый набор (`--affected`) и
широкий выбор стартует только окружение с операторским грантом
`PROTOCOL_OPERATOR_HEAVY=1` (его выставляют поезд посадки, авторская проверка
оператора и окружение фермы); без гранта водитель печатает одну строку отказа
(`heavy runs are the operator's: ...`) и выходит с отдельным кодом 3, до любых
проверок. Месту доступны только узкие наборы: пустое значение `--file`/`--only` —
ошибка использования, а выбор (`--file`/`--only`/`--rerun-failed`), совпадающий
более чем с 12 тестовыми файлами, считается тяжёлым и требует тот же грант;
например `node .ai/bin/protocol-test.cjs --root . --file tests/<file>.test.cjs`.
Тяжёлые файлы проекта (сборка продукта и его установка) без гранта сообщают
пропуск теста с той же причиной, а не молчаливый успех.
Селектор печатает причины отбора. Неизвестное влияние требует FULL fallback;
при `PROTOCOL_NO_FULL_SUITE=1` он блокируется и передаётся оператору посадки.
Сужать такой набор до произвольной проходящей части нельзя.
Полный набор выполняется в поезде посадки. Семантика переменной для handoff record
сохранена; затронутые прогоны остаются диагностическими.
Установленные проекты используют собственный механизм отбора и проверки продукта;
правило гранта действует и там: их водитель несёт ту же проверку.

---

## 8. Propagation

This file is listed under `managed` in `protocol-manifest.json`, so the installer
delivers it to every project and an upgrade refreshes it. A project whose installed
copy predates this file does not have it until it is upgraded; check
`protocolVersion` in its `protocol-manifest.json` before assuming these rules are
present there.

---

## 9. Kernel dispatch (source repository only)

Kernel agent dispatches are governed by `.ai/bin/protocol-dispatch.cjs`:

- Prompts are files. A dispatch never injects prompt prose inline on the command line; the invocation carries the one pointer line: `Read and follow the file <launch>`.
- Client commands are built only by `.ai/bin/protocol-dispatch.cjs` from `.ai/docs/clients.json`.
- Flags are accepted only as verified from `--help`, with binary version and verification date recorded.
- A new failure mode goes into the registry (`.ai/docs/clients.json`), not only into an individual run (PROTO-DEC-0050 item 3).
- Every attempt runs in a private clone with the Level-1 environment (PROTO-DEC-0070, PROTO-DEC-0077 item 3): detached HEAD, remotes removed, no-push rule enforced, and credential canaries stripped.
- Liveness is evaluated per PROTO-DEC-0075 item 5 (heartbeat progress, useful output growth, stall and hard limits).
- The old runners are superseded for new dispatches.
- Recovery follows PROTO-DEC-0075 as implemented here.
- Resolver order: For slots without an explicit route, selection evaluates ladder rungs across route data completeness, hard constraints (contextMin per PROTO-DEC-0075 item 8), floor checks (max(tiers) >= floor per PROTO-DEC-0059 item 2; tier-unknown if empty), independence exclusions (PROTO-DEC-0075 item 13), approval gates (needs-approval for owner-long-task when long=true and unapproved per PROTO-DEC-0076 item 1, PROTO-DEC-0078 item 4), and liveness probes (levels 0-1). Admissible rungs are sorted cheaper-first by largest rung number then lowest declared order. Substitutes proceed up the ladder by decreasing rung number then increasing order. Terminal cases (no admissible rung, or shortfall on kernel/certification stages) stop execution before launch per PROTO-DEC-0078 item 3 and workflowAI 1.5; escalation occurs only on verified failure per PROTO-DEC-0079 item 2.
- Supervisor recovery: Actions per failure class follow the Russian owner text and PROTO-DEC-0075 items 3, 5, 11. The attempt budget allows the primary its initial run plus one retry on retryable classes, two attempts per substitute, at most six fresh invocations in total, and resumes counted separately (up to three wakes per attempt per PROTO-DEC-0051 item 4, and one resume per crash or repair). Hard timeout stops the step as BLOCKED. Resume-first semantics govern STALL (wake pointer to `.ai/docs/dispatch/wake.md`) and PROCESS_CRASH, while INVALID_OUTPUT/VALIDATION_FAILURE triggers one repair resume with pointer to a synthesized repair file holding `.ai/docs/dispatch/repair.md` and failing check rows. Non-retryable classes (AUTH_ERROR, CONFIG_ERROR, MODEL_UNAVAILABLE, QUOTA_EXHAUSTED) fail over immediately to substitutes. RATE_LIMIT (60s wait) and NETWORK_ERROR/PROVIDER_ERROR (30s wait) retry once before failover.
- Launch pinning, completion contract, and run records: Before the first attempt, the supervisor records launch pins (HEAD commit SHA, launch file path and sha256, copyIn file hashes, dispatch sha256). Pre-attempt hash verification blocks modified inputs as `pin-changed` unless `--revise` initiates a new launch revision. A step achieves DONE only when the process exit code is recorded, all declared outputs exist and are non-empty valid UTF-8, slot validation exits 0, copied-back journal contains an `Evidence:` line, and supervisor certifies `supervisorDone`. Every settled step appends a run record satisfying `docs/specs/run-record.schema.md` to `docs/ops/RUNS.jsonl`, which serves as the source for `renderUsage` and dispatch reporting.
- Client note (vibe): never edit an entry after `record`; add a new one. Editing an existing entry invalidates the format-2 entry hash and fails verification.
- This dispatch mechanism is not installed into host projects until the owner decides.

---

## 10. Signals ledger (source repository only)

The signals ledger `.ai/SIGNALS.md` is append-only and written only through `.ai/bin/protocol-signals.cjs`. Its line grammar lives in `docs/specs/signals-ledger.md` (one home; R-L0-12).

- Signal types (`procedure-gap`, `script-candidate`, `fall`) are recorded per PROTO-DEC-0051 items 2-4.
- Any participant can record a signal with `add`. A `Signal:` journal line is still accepted from a participant that cannot run the script, and the next `import` brings it in once by hash without modifying journals.
- At batch planning, the coordinator runs `plan --batch <id> --stamp` and records groups and dispositions with `update`; an `ESCALATE` row goes to the owner (PROTO-DEC-0051 item 2).
- A `script-candidate` is tested against the four conditions of executable rulebooks and recorded as `script:<path>` or `kept-by-assistant:<n>` (PROTO-DEC-0051 item 3).
- Falls come automatically from the kernel dispatcher upon attempt fall (PROTO-DEC-0051 item 4).
- Ledger consumers are P-L0-001 and P-L0-006; M-008 counts come from `node .ai/bin/protocol-signals.cjs count`.
- While `CLI-AGENTS.md` is installed into host projects (`managed`), `.ai/SIGNALS.md` and `protocol-signals.cjs` are registered as `source` and remain in this repository only.

---

## 11. Operator layer: launches, state tick, silence alert, processes

These tools are installed into every project (`.ai/bin/operator/`). They read files and
processes only, call no model and send nothing over the network.

**Starting an executor or a reviewer.** The standard way is the launch wrapper of the pilot
kit, `docs/ops/launch-wrapper.cjs run` (installed by `<product>/docs/ops/pilot-install.cjs`):

```
node docs/ops/launch-wrapper.cjs run --stream S --task T-302 --owner O --name N --worktree W -- CLIENT-COMMAND ARGS
```

`run` registers the wrapper and child PID, the worktree, the task and the start time
(the running record of the launch in `.ai/runtime`) and writes a terminal record on every exit. A hand-written
launcher has no record: nothing below can see it, so a dead or stuck executor stays invisible.

Переключатель auto-assignment читается из `.ai/runtime/assignment-mode.json`
основного checkout оператора либо из абсолютного `COLABUS_ASSIGNMENT_MODE_FILE`.
Путь внутри запускаемого worktree или другого package checkout отклоняется;
отсутствующий, недействительный или `off` файл сохраняет прежний запуск.
`docs/ops/assignment-mode.json` в пакете не даёт полномочий на запуск.
`cert-launch` требует явные `--client` и `--model`: для сертификаторов switch
даёт только телеметрию, не выбирает маршрут и не служит assign admission gate.
Даже включённый точный класс сертификатора не разрешает auto-assignment.

**Status.** `node .ai/bin/operator/layer.cjs status` (or `launch-wrapper.cjs status`) shows
each launch as alive, stalled, dead or exited, with the last file change, the last commit and
whether the handoff is pending. Stalled means alive with no file change in the worktree for
longer than the idle threshold, or running longer than the route p90 plus 10 percent. The
threshold is max(15 minutes, 10 percent of the route p90 duration) when at least five finished
launches of the same route exist, else 30 minutes (`operatorLayer.idle`). A finished launch
stays `handoff=pending` until the operator accepts its result:
`node .ai/bin/operator/layer.cjs accept --name N`.

The default view of `status` lists the launches that are alive, stalled or dead, every exited
launch with a pending handoff (of any age) and the launches that exited in the last 24 hours;
`status --all` prints the full history. The counts on the `RESULT` line always cover every
record. The reads are bounded so that status answers in seconds on a long-lived project: the
last change of a worktree is the newest mtime among the files git reports as changed (at most
2000 paths) and the head commit time, never a walk of the tree (files git ignores do not
count; a directory without `.git` is walked to at most 5000 entries and depth 8). Every alive
launch gets these columns; dead launches and pending handoffs share a cap of 64 distinct
worktrees, dead first, then the newest. The `RESULT` line states the filter, the caps and how
many rows went without details. `tick` and `silence` use the same reads.

**Operator report rule.** The columns "process alive" and "last change" of an operator report
come only from `status` and the tick, never from memory or an earlier report.

**State tick.** `node .ai/bin/operator/layer.cjs tick` prints one first line:

- `NEW` - the owner inbox file (`operatorLayer.ownerInbox`, default `docs/ops/OWNER-ADDENDA.md`) changed;
- `WORK` - a ready task with free launch capacity, an active task without a live launch, a dead,
  stalled or finished launch whose handoff is pending, a review file with a verdict since the
  last acknowledgement; `ESCALATE` in front when a task of `operatorLayer.criticalPath` is idle
  for twice its threshold (a local alert is written and shown);
- `NOOP` - nothing to do;
- `ERROR` - an input is unreadable (exit 1; never a false `NOOP`).

After acting, the operator runs `layer.cjs tick --ack`. The inputs come from the project adapter:
the backlog (`operatorLayer.backlog`; by default `.ai/runtime/CANDIDATES.md` when present, else a
table in `docs/backlog/BACKLOG.md` with an `ID` and a `Status` column, else task cards with a
`Status:` line under `docs/backlog/tasks/`), the worktrees, the launch records and `docs/reviews/`.

**Silence alert.** `node .ai/bin/operator/layer.cjs silence` alerts when no commit, launch,
journal, review or backlog change happened for `operatorLayer.silence.quietMinutes` (default 30)
while work is pending: it writes `.ai/runtime/operator-alert.json`, one line in
`.ai/runtime/operator-alerts.jsonl` (`layer.cjs alerts` prints them for the report) and shows a
Windows toast where available. It is local only; at most one alert per `repeatMinutes` (120).

**Schedules.** `kernel-install` registers the tick (every 15 minutes) and the silence alert
(every 20 minutes) in Windows Task Scheduler. On other systems it prints the two crontab lines to
add. Opt out with `"operatorLayer": { "schedules": { "enabled": false } }` in
`protocol-manifest.json`. By hand: `node .ai/bin/operator/schedule.cjs install|check|remove
--root .`. The validator warns (`CM-73`) when the schedules are not registered or the last tick
is older than twice its interval plus five minutes.

**Processes.** `node .ai/bin/operator/processes.cjs list` lists agent and MCP processes of this
project older than `operatorLayer.processes.olderThanHours` (default 6) with their CPU time.
`processes.cjs stop --pid N` stops only a PID the launch wrapper registered for a running launch.
Any other process is stopped only through a list: `list --write-list FILE` writes it, the owner
reads it, removes rows that must keep running and sets `confirmedBy` to their name, then
`stop --list FILE` stops each row whose PID, start time and name still match.

**Kernel overhead.** Run a kernel step through the meter,
`node .ai/bin/operator/layer.cjs step --task T --step validator -- node .ai/bin/protocol-validate.cjs --root .`
(`--class certification` for certification), and read the share of the task's wall time with
`layer.cjs overhead --task T`. The target is at most 5 to 10 percent; certification is counted
separately.
