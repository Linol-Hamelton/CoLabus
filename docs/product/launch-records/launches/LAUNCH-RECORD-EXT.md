# launch-record/1: optional fields

The base fields and the 29 existing records are unchanged and stay valid. Every field below is OPTIONAL: a record
without it is valid; a record with it must carry the stated type. Unknown extra fields are rejected by the validator
(typos must not become data). `schema` stays `launch-record/1`.

## Canonical shape (what the operator's helper writes)

```text
launchId, startedAt, endedAt, callerSession, channel ("catalog-layer"), task, promptPath, promptSha256,
tuple { client, model (as the client reported it, else null), effort (or null) },
workdir, head, treeState, calleeSession, exitCode, outputs [{path, sha256}], tokens, cost (or null with costNote),
viaDispatch (false), backfilled (true for records rebuilt after the fact)
```
`task` is a short label; `promptPath` and `promptSha256` name the prompt file, never its text. No command lines, no
environment values, no keys, no tokens of any provider (the validator rejects secret-shaped strings).

## Extension fields (all optional)

| Field | Type | Meaning |
|---|---|---|
| `role` | string | role slot of the assignee (`ROLE-*` without prefix), from the task-frame |
| `stage` | string | stage id of procedure.schema.md 2.2 |
| `taskClass` | string | class (role class, complexity tier); `unknown` allowed |
| `packetHash` | string | `sha256:<hex>` of the compiled instruction, empty or absent when none was used (A/B key) |
| `reviewOutcome` | string or null | `PASS`, `RECOMMENDATION`, `FAIL`, `BLOCKED`, `NONE`; null until a verdict exists |
| `route` | string | how the model was reached: `cli:<client>`, `dahl`, `vercel`, `direct-api`, ... (same model, different route behaves differently) |
| `riskClass` | string | `A` or `B` (PROTO-DEC-0038) |
| `tier` | string | `T1`..`T9` from P-L2-002 |
| `attempt` | integer >= 1 | attempt number on the same task; `retryOf` names the earlier launchId |
| `attemptClass` | string | Для seat launcher: `SUCCESS`, `AUTH`, `QUOTA`, `TRANSIENT`, `OTHER`; результат процесса, независимо от вердикта отчёта. Поле необязательно для старых записей. |
| `retryOf` | string | launchId of the attempt this one repeats |
| `failureClass` | string | when exitCode is not 0: `STALL`, `TRANSPORT`, `QUOTA`, `AUTH`, `CONTENT`, `ORPHAN`, `INTERRUPTED`, `UNKNOWN`, `NO_VERDICT` (the report has no closed verdict token), `TURN_LIMIT` (vibe stopped on its turn limit), `SERVED_MODEL_MISMATCH` (the served model was proven and is not the requested one; the launch is not a verdict) |
| `reviewRounds` | integer >= 0 | review rounds until the verdict that closed the task |
| `reviewerLaunchId` | string | launchId of the reviewer's or certifier's launch (links author and reviewer) |
| `variant` | string | A/B pilot arm: `A`, `B`, `none`, `inline`, `pointer` |
| `pairId` | string | A/B pilot pair: `implementer-execute`, `reviewer-accept`, `coordinator-dispatch` |
| `packetBytes` | integer | bytes of the compiled instruction (from its manifest) |
| `packetEstTokens` | integer | estimated tokens of the compiled instruction (estimated, not measured) |
| `wallSeconds` | number | end minus start; derived when both times exist |
| `confidence` | object | for backfilled records: per field `exact`, `derived`, `inferred` or `unknown`, so analysis can weigh them |
| `source` | string | for backfilled records: the file the data came from (call file, launcher, journal) |
| `servedModel` | string | the model that actually answered, as a source outside the report names it (PROTO-DEC-0169 item 4); absent when no source exists |
| `servedModelSource` | string | where `servedModel` came from (PROTO-DEC-0209): `agent-result` (AGENT_RESULT JSON of the openai-compat agent), `client-banner` (a model line the client printed at its fixed place: the codex header block that OPENS a stream; never a line found inside text), `client-log` (the client's own log file or session store, e.g. the vibe unified session store), `launcher-model` (the explicit `--model` the launcher passed to agy, a fact read from the argv the client was really started with), `none` (no structured source for this client) |
| `servedModelConfidence` | string | `exact` (the client named the model it used), `derived` (read from the client's own log or session store, or from the launcher argv), `none` (no source) |
| `requestedModelVia` | string | how the requested model reached the client, read from the argv and environment the launcher really started it with: `flag` (the model id is the value of the last model flag of the client's own grammar, before any `--`), `alias-env` (vibe takes it by `VIBE_ACTIVE_MODEL` and the value names the requested model, a name and its alias being one model), `not-passed` (the client ran on its own default, or the flag or alias names another model; `tuple.model` is then only what the launcher intended). The writer stores the value it is handed; `docs/ops/cert-launch.cjs` and `docs/ops/fix-launch.cjs` derive it with `requestedModelVia()` from the argv they started |
| `launchRole` | string | the role of the launch for the L6 metrics: `author`, `certifier`, `pre-review` or `unknown` (the launcher states it, and a launch whose role nobody stated is recorded as `unknown`, never as a default; `role` keeps the packet role) |
| `costSource` | string | where the cost comes from, derived from `cost.basis`: `api-price-table` (priced), `subscription`, `unknown` (an unknown cost or a legacy plain value). The writer of this version adds it whenever it writes a `cost`; the validator requires a `cost` wherever `costSource` is present and refuses a disagreement. Records written before this field carry a `cost` without `costSource` and stay valid, so the field is NOT present on every record that has a cost |

Analysis rules: a field that is `unknown`, null or absent is skipped, never imputed; a backfilled record counts only for
fields whose `confidence` is `exact` or `derived`.

Served-model rules: `tuple.model` stays the requested model; `servedModel` is never copied
from it and never from the report text. `servedModel` requires `servedModelSource` other than `none`; `servedModelSource`
`none` goes with `servedModelConfidence` `none` and no `servedModel`. The three fields are advisory: the record validator
checks their shape, nothing in the record blocks a launch. The operator acceptance tool `docs/ops/seat-check.cjs` compares
`tuple.model` with `servedModel` and refuses a certifier seat whose served model is missing or differs. Writer:
`docs/ops/served-model.cjs` (`deriveServedModel`), called by `docs/ops/cert-launch.cjs` and `docs/ops/fix-launch.cjs` after the child exits.

Where a served model may come from (PROTO-DEC-0209): only from a STRUCTURED source - the codex client banner, a client's JSON output or JSON event
stream, the vibe export (`export.json` in the launcher-fixed `--output-dir`, PROTO-DEC-0215 item 1), and an explicit `--model` passed by the launcher (agy). Free-text logs in key=value or similar formats (the mimo/opencode text log)
and free-text banners (the mimo `> build · <model>` line) are NOT proof sources; where a client has no structured source, the served model is unknown with the reason `no structured source`, never a
guess or a number. Structured sources keep the strict reading: one well-formed record of the schema at the fixed position the client prints it, unique keys, the shared guarded
reader with the identity judged of the read object at read time, and binding to the printed session. Nothing is scanned for a banner-like line, so a quotation of a banner in Markdown, HTML, indented code, a block quote or
plain text proves nothing. A stream position is a proof only when the CLIENT writes the line there before any model output and the model cannot produce text in that stream: codex writes its own
header to stderr and the model's text to stdout, so a line at the start of stdout is the model's answer and is never a proof. Position rules, per client-owned stream (stderr, and a client log file the
caller named as `logFiles` (see below); a BOM and blank lines before the first line are skipped; a line is read at column 0):

| client | source | position rule |
|---|---|---|
| codex | `client-banner`, exact | the header block opens a stream: first non-blank line `OpenAI Codex ...`, a `----` line, `key: value` fields, a closing `----` line; its `model:` field. A block further down is not read; a block with a line that is not a field, or not closed within 30 lines, proves nothing; the headers of stderr and of a named client log file must agree; stdout is never read |
| mimo | `none` | no structured source (PROTO-DEC-0209): the text log and the text banner are free text, not proof sources; the record says `no structured source` and the module reads no file and no line of the client |
| vibe | `client-log`, derived | the export of the launcher-fixed output directory: the launcher creates a new empty directory per launch and starts vibe with `--output-dir <dir>`; vibe writes `export.json` there on every exit, and the model is read only from that file, at the one fixed path `config.active_model`, through the guarded reader, the shared strict decoder and a parse with unique keys (PROTO-DEC-0215 item 1); the session store, a printed session line and a client log file are not sources |
| dahl | `agent-result`, exact | the line `AGENT_RESULT {json}` is the LAST non-blank line of stdout (the agent prints its result last and writes the model's text to its transcript file); an earlier line is not read; the same line at the end of a named client log file must name the same model (`conflicting sources`) |
| agy | `launcher-model`, derived | the explicit `--model` the launcher passed (`requestedModelVia` `flag`, read from the argv the client was really started with); without the flag there is no evidence and no guess |
| claude, kilo, others | `none` | no structured source in this module: unknown with the reason `no structured source` (the operator proof of the kit reads native json envelopes, a separate package) |

The proofs of one launch are combined: whichever of the structured field (the dahl result line) and the client's log or the vibe export have spoken must all name the same model, else the served model is unknown with the reason `conflicting sources` (a single source proves only when no other contradicts it). The explicit `--model` proves only for agy (PROTO-DEC-0209); for every other client it says what was asked, and a proven model that differs from it keeps `match` false, the launchers' mismatch marker.

The decision is a table (`TABLE` in `served-model.cjs`, and a generated test builds a fixture for every cell). Dimensions of a cell: the state of each source (`absent`: no evidence; `one`: names exactly one model;
`several`: names several, which includes a key written twice in JSON, two `modelID` in one log line, sessions that disagree; `malformed`: spoke and cannot be read or names no model; `foreign`: provenance not proven),
the sessions the client printed and found (`none printed`, `one`, `several` printed and all found, `mismatch`: a printed session is not found), and whether the sources agree. One source: `absent` and `foreign` are silent; `one` names the
model; `several` and `malformed` are negative (unknown, with the reason that source gives). A printed session that no admissible log or session store holds makes the source negative (`printed session not proven`) in every case, also when
there is no log at all; a foreign file is never read and changes nothing. Two sources: both silent is unknown (no evidence, no reason); one speaking decides alone (its model, or its own negative reason); two that name one model and agree
prove it; two that disagree, or a negative beside any speaker, are `conflicting sources`. A proven model is then compared with the requested one: the same is match yes, another is match no (the mismatch marker). Unknown never carries a model,
a source or a confidence. JSON is read with duplicate-key detection: a key written twice names several models, and `JSON.parse` keeping the last one is never used for a proof.

A client log file is read as a source only with its provenance proven: the caller names it in `logFiles` together with `clientLogDir`, the client's own log directory; the file must lie inside that directory (its real path, no link, no hard link) and
have been written inside the launch window. The module reads the file itself, whole; a file above 256 KiB is an admissible but unreadable source - unknown with the reason `client log above the read limit`, never a
decision made from a head-and-tail prefix of it (a second header block in the unread middle would be lost and the first record alone could prove). The size is judged by the fstat of the opened descriptor BEFORE any
byte is read; the log is decoded through the shared strict decoder of text-safe before any parsing - invalid UTF-8, a lone surrogate, a BOM or NUL refuse, and the log is an unreadable source with the reason
`unreadable client log` (CRLF is normalised, not refused).
A text a caller passes without a file (the former `logStreams`), a file outside the client's own log directory and a file written outside the window have no provenance and are never read. The same rule applies to a transcript the model wrote.
Every file the module reads as evidence (a client log file, a vibe `meta.json` and `runtime-state.json`) passes one guard: a regular file whose real path lies inside the client's own directory (the log directory the caller named,
the vibe session store), with no symbolic link, junction or hard link (link count above 1) on the way; anything else is foreign and is never read. The identity, the size and the mtime are judged of the OPENED DESCRIPTOR the bytes were read from (the guard's own fstat), never of a later stat of the name: a fresh file swapped onto the name after the read lends its mtime to nothing. The directory itself is the caller's choice and may be a link.

One strict parser per source: a source proves a model only when it is one well-formed record of its known schema in which exactly one non-empty model value occurs exactly once. An empty value, a value written twice (even with
equal values), a repeated JSON container, a malformed or truncated record and an additional model each give no proof and a named reason (`repeated model line` for two equal codex model lines; `unknown launcher flag` for an agy
flag value that is not one well-formed model id). A value is counted before it is compared, never collapsed first. Many lines of one session that name one model, several generations
that name one model and two sources that agree are not repetitions of a key.

A caller that has the streams apart passes `stdout` and `stderr`. A caller with one capture (`capturedOutput`) or with stdout alone cannot say which stream a line came from: for codex that is no proof (unknown), and only dahl's
result line is read at the end of the capture. So a model answer that begins with a perfect header proves nothing (the position rule alone cannot tell it from the client's line). The ids a mixed capture printed still bind the launch to its sessions (they are read from parsed structured output).

Raw data of the L6 metrics (since 2.0.1): the writer names the five token kinds `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning` in every
`tokens` object, an unprinted kind as `null` (never `0`, never absent; a kind the caller left `undefined` is `null` as well); `requestedModelVia`, `launchRole` and `costSource` are written by the launchers and the
writer, never inferred from the report. `requestedModelVia` is a launch-time fact; for agy it is also the structured source of the served model (`launcher-model`, PROTO-DEC-0209), for every other client it is no proof of it: that stays `servedModel` with its source.
agy without the flag, and mimo, claude, kilo and every client this module does not know, record no served-model field; the record note names the reason (`served-model-unproven reason="no structured source"` for the clients without a structured source). Old records carry none of the three fields and stay valid.

Output path of `launch-stats.cjs report --out`: the path is judged once on the paths it names; the report is written only through the shared guarded functions below a root pinned at that judgement
(a link at any level is refused, also one put in between the judgement and the write), and the real target is judged for `.ai` and the ladder once more right before the rename, with the protected `<main root>/.ai` read afresh at every judgement (an `.ai` replaced by a link after the first judgement is refused) and once more after the rename (a report that reached `.ai` in the last instant is reported as a failure, not as ok). The remaining check-to-write window is the documented limit of the shared writer (`writeAtomicGuarded`): the open temp file pins the directory written to on NTFS (measured there only), on POSIX the window is narrowed, not closed, and the pin does not protect `.ai` itself, so a link put at `.ai` in that instant is detected after the rename, not prevented. Network-share spellings (two leading
separators and a host), device spellings (two leading separators, then `?` or `.`) and drive-relative spellings (a drive letter with no separator after it, or one leading separator) are refused by their
name before the file system is touched: a network share is not a destination of a local advisory report; allowing one would be a decision of the owner.

## Tokens and cost (cost-record, PROTO-DEC-0179 item 3)

`tokens` and `cost` are base fields; since the cost-record work every launcher fills them, and an OBJECT now has an exact shape (the validator rejects any other).
A plain legacy value (`null`, an integer `tokens`, a number `cost`) stays valid.

```text
tokens { input, output, cacheRead, cacheWrite, [reasoning], [total], source, [note] }
  input = fresh (not cached) input tokens; cacheRead / cacheWrite = cached tokens read / written; output = all output tokens (reasoning included,
  `reasoning` is the informational part of it); total = what the client states (may include the cache); each number is an integer >= 0 or null
  (null = the client does not say; a client that says nothing leaves tokens null or absent, never zeros); source = where the numbers came from
  (mimo-json, mimocode-db, vibe-session-store, codex-json, codex-banner, claude-json, agy-json, agent-result)
  a single counter the client did not print is null too (an explicitly printed 0 stays 0); without the cached count the fresh input of a
  client whose input includes the cache (codex, vibe, agy) is null; without mimo's reasoning its whole output is null; a cached count above the input is
  no split (both null); total = the printed total, else the sum of the printed counts when they cover every token class of the client, else null.
  A null cache component makes cost unknown unless the source's input already holds that class (launch-cost.cjs INPUT_COVERS).
cost { usd, basis: priced | subscription | unknown, priceSnapshot { id, hash, capturedAt }, formula, [model], [note], [reason],
       [clientReportedUsd], [clientCostBasis], [listEquivalentUsd] }
  priced       usd = tokens x the per-million price of the canonical model id in the price snapshot nearest to the launch (a snapshot more than 48 h away is
               refused: unknown), the standard route of data/prices with the LOWEST TOTAL for the token mix; exact decimal; priceSnapshot and formula say how;
               an estimate at aggregator list price, NOT the provider invoice
  subscription a flat-fee client (claude Pro, codex ChatGPT, agy Antigravity Pro, copilot): usd null, no per-launch charge; the spend reservation lives in
               the route budget ledger, not in the record; listEquivalentUsd keeps the client's own list-price figure (claude total_cost_usd), never a bill
  unknown      usd null and a reason; NEVER written as zero (the validator refuses usd 0 with basis unknown or subscription)
  clientReportedUsd  the client's own cost number (mimo step cost), information only, kept next to ours (never instead of it)
```

`calleeSession` carries the client's own session id when the output names one (mimo `ses_...`, vibe, codex thread, claude and agy session ids).
No key, account id, wallet or balance is ever part of a cost; the launchers fill the token and cost fields from the usage each client prints.

Backfilled usage lines (`launch-fill.cjs usage`) are `finished` events: `{schema, launchId, event: "finished", endedAt, tokens, cost, [calleeSession], backfilled: true,
confidence {tokens: exact | derived, cost: derived | unknown}, source}`. exact = the numbers the client printed for that launch (call file segment matched by name and end
time); derived = matched by directory and launch window, or computed. A cost of confidence unknown counts as unknown in the statistics.

## Files and flow

- Buffer (untracked, outside `.ai/`): `launches/pending/*.jsonl`, one line per launch, written by the launcher helper (`docs/ops/cert-launch.cjs`, `docs/ops/fix-launch.cjs`, `docs/ops/launch-record.cjs`).
- Journal (tracked): `launches/LAUNCHES.jsonl` (the 29 records of 2026-09-30..10-02, frozen) and, per machine (PROTO-DEC-0174 item 2), `launches/LAUNCHES-<machine>-<YYYYMM>.jsonl`
  with the sync ledger `launches/LAUNCH-SYNC-LEDGER-<machine>.jsonl`, written by the journal sync (plan by default, `--execute` with the plan hash; see
  launches/JOURNAL-SYNC-README.md). The sync never deletes or edits a pending file and skips (and lists) a record that fails this validator.
- The validator (launch-record-validate, class B) checks a file or the buffer: shape, types, enumerations,
  secret scan, unique launchId; the merge command refuses a buffer that fails it and never rewrites an existing line.
