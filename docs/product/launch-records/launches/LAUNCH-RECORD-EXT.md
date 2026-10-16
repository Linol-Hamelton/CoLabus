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
| `taskClass` | string | class from  (role class, complexity tier); `unknown` allowed |
| `packetHash` | string | `sha256:<hex>` of the compiled instruction, empty or absent when none was used (A/B key) |
| `reviewOutcome` | string or null | `PASS`, `RECOMMENDATION`, `FAIL`, `BLOCKED`, `NONE`; null until a verdict exists |
| `route` | string | how the model was reached: `cli:<client>`, `dahl`, `vercel`, `direct-api`, ... (same model, different route behaves differently) |
| `riskClass` | string | `A` or `B` (PROTO-DEC-0038) |
| `tier` | string | `T1`..`T9` from P-L2-002 |
| `attempt` | integer >= 1 | attempt number on the same task; `retryOf` names the earlier launchId |
| `retryOf` | string | launchId of the attempt this one repeats |
| `failureClass` | string | when exitCode is not 0: `STALL`, `TRANSPORT`, `QUOTA`, `AUTH`, `CONTENT`, `ORPHAN`, `INTERRUPTED`, `UNKNOWN`, `NO_VERDICT` (the report has no closed verdict token, ), `TURN_LIMIT` (vibe stopped on its turn limit), `SERVED_MODEL_MISMATCH` (the served model was proven and is not the requested one; the launch is not a verdict) |
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
| `servedModelSource` | string | where `servedModel` came from: `agent-result` (AGENT_RESULT JSON of the openai-compat agent), `client-banner` (a model line the client printed, e.g. mimo `build · <model>` or codex `model: <id>`), `client-log` (the client's own log file, e.g. the mimocode session log), `none` (no reliable source for this client) |
| `servedModelConfidence` | string | `exact` (the client named the model it used), `derived` (read from a log matched to the launch window), `none` (no source) |

Analysis rules: a field that is `unknown`, null or absent is skipped, never imputed; a backfilled record counts only for
fields whose `confidence` is `exact` or `derived`.

Served-model rules (D9, owner  item 6): `tuple.model` stays the requested model; `servedModel` is never copied
from it and never from the report text. `servedModel` requires `servedModelSource` other than `none`; `servedModelSource`
`none` goes with `servedModelConfidence` `none` and no `servedModel`. The three fields are advisory: the record validator
checks their shape, nothing in the record blocks a launch. The operator acceptance tool `docs/ops/seat-check.cjs` compares
`tuple.model` with `servedModel` and refuses a certifier seat whose served model is missing or differs. Writer:
`docs/ops/served-model.cjs` (`deriveServedModel`), called by `docs/ops/cert-launch.cjs` and `docs/ops/fix-launch.cjs` after the child exits.

## Tokens and cost (cost-record, PROTO-DEC-0179 item 3, )

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
No key, account id, wallet or balance is ever part of a cost. The measured usage of each client is in  (usage matrix);
how the launchers fill the fields is in .

Backfilled usage lines (`launch-fill.cjs usage`) are `finished` events: `{schema, launchId, event: "finished", endedAt, tokens, cost, [calleeSession], backfilled: true,
confidence {tokens: exact | derived, cost: derived | unknown}, source}`. exact = the numbers the client printed for that launch (call file segment matched by name and end
time); derived = matched by directory and launch window, or computed. A cost of confidence unknown counts as unknown in the statistics.

## Files and flow

- Buffer (untracked, outside `.ai/`): `launches/pending/*.jsonl`, one line per launch, written by the launcher helper (`docs/ops/cert-launch.cjs`, `docs/ops/fix-launch.cjs`, `docs/ops/launch-record.cjs`).
- Journal (tracked): `launches/LAUNCHES.jsonl` (the 29 records of 2026-09-30..10-02, frozen) and, per machine (PROTO-DEC-0174 item 2), `launches/LAUNCHES-<machine>-<YYYYMM>.jsonl`
  with the sync ledger `launches/LAUNCH-SYNC-LEDGER-<machine>.jsonl`, written by  (plan by default, `--execute` with the plan hash; see
  launches/JOURNAL-SYNC-README.md). The sync never deletes or edits a pending file and skips (and lists) a record that fails this validator.
- The validator  (Claude, class B) checks a file or the buffer: shape, types, enumerations,
  secret scan, unique launchId; the merge command refuses a buffer that fails it and never rewrites an existing line.
