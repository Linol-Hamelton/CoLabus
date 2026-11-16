# Schema of the pre-review route registry (prereview-routes/1)

Registry file: `tools/operator/prereview-routes.json`. Reader and writer:
`tools/operator/prereview.cjs` (the registry is read ONLY through the repository
strict reader - `.ai/bin/lib/text-safe.cjs` decode with bom/crlf/invisible refuse and
`parseJsonUnique` (duplicate keys refused) - and every change goes through the ONE writer
`updateRegistry`: a mkdir lock next to the registry that records its creator pid and creation
time in a file inside the lock, a strict re-read inside the lock, only this run's per-route
changes, an atomic temp-file-and-rename write; a lock older than 5 minutes whose pid is not
alive is renamed aside - suffix `.stale`, never deleted - and the update proceeds, while a live
or fresh lock waits and then refuses with the fixed code `PREREVIEW-REGISTRY-LOCK`).

The registry is data, not code: a route changes by editing this file, never by editing the tool.
Sources: the free-route inventory of 2026-10-16 and the 2026-10-14 memory that reasoning
parameters differ per route (PROTO-DEC-0206 item 2 (5); PROTO-DEC-0216).

## Top level

| field    | type   | meaning                                             |
| -------- | ------ | --------------------------------------------------- |
| schema   | string | must be exactly `prereview-routes/1`                |
| comment  | string | provenance note; free text                          |
| routes   | array  | non-empty array of route objects                     |

## Route object

| field           | type            | meaning                                       |
| --------------- | --------------- | --------------------------------------------- |
| id              | string          | lowercase slug (`^[a-z0-9][a-z0-9.-]*$`), unique; route identity |
| provider        | string          | provider id; it MUST be a key of the reasoning whitelist table below - an unknown provider refuses the route |
| endpoint        | string          | https URL of the chat completions endpoint with `${ENV_NAME}` placeholders (`[A-Z][A-Z0-9_]*`) resolved at send time; the RAW string holds no `?` and no `#` at all, so an empty query or an empty fragment refuses, and it is parsed with `new URL`: no username, no password, no query string, no fragment; a loopback http URL (host 127.0.0.1, localhost or [::1]) is valid only so tests can run fake endpoints; at send time every substituted value must match `^[A-Za-z0-9._-]{1,128}$` before it enters the URL and the FINAL URL is checked on its raw string and parsed again with the same contract (an injecting environment value is a refusal with the fixed code `ENDPOINT_REFUSED`, and a placeholder without a value is refused the same way) |
| model           | string          | model id exactly as the provider expects it in the request body |
| keyEnv          | string or null   | name of the environment variable holding the API key; the value is read inside the request and never stored, logged or written anywhere; null means the endpoint needs no key |
| paid            | boolean         | true: the route spends paid credit and runs only under an explicitly selected panel, in probe and review |
| reasoningParams | object or null   | the reasoning parameter set of this route: exactly the whitelisted flat field names of its provider (see the table below), each with a scalar value; null or `{}` when the route needs none |
| maxTokens       | positive integer| completion token budget for a review request (a route that thinks needs a large one: kimi 24000) |
| probeMaxTokens  | positive integer| completion token budget of the tiny probe request (no repository content is ever sent) |
| probe           | object          | last probe: `time` (ISO 8601 UTC string `YYYY-MM-DDTHH:MM:SS(.mmm)Z` or null; valid only when `new Date(time).toISOString()` equals the stored value to the second, so a normalized impossible date such as 2026-02-30 is refused), `result` (`unprobed`, `ok`, `fail`), `note` (string or null; the tool writes fixed codes only) |
| status          | string          | `unprobed` (never used until a probe succeeds), `ok` (last probe succeeded; the only usable state), `failing` (a probe failed, or a review answer was empty, truncated, oversized or malformed; the route stays out of use until a new probe of that route succeeds) |

## The reasoning whitelist

`reasoningParams` is NOT free-form. The whitelist is a table keyed by provider id, written here
and in `REASONING_FIELDS` in `tools/operator/prereview.cjs` (rule R1):

- the provider must be a key of the table: an unknown provider refuses the route;
- a key must be in that provider's list, so `messages`, `model` and `max_tokens` are never in any
  list (they are the reserved fields of the request body);
- key names match `^[a-z][a-z0-9_]{0,31}$`: no dots, no nesting;
- values are scalars only: a string up to 64 characters, a finite number, a boolean or null;
- an object or array value refuses the registry.

| provider     | allowed field  |
| ------------ | -------------- |
| openrouter    | `reasoning_effort` |
| cloudflare   | `reasoning_effort`, `enable_thinking` |
| dahl         | (none)         |
| ollama-cloud | (none)         |
| vercel       | (none)         |

Any other key refuses the registry, so a secret-named key cannot enter the request at all; no
secret-name hunt is needed. A field name is never reproduced in an error message, only its
length. Adding a field or a provider means editing this table and `REASONING_FIELDS` in one
change.

## Invariants maintained by the tool

- The one usability gate is `usable(route)`: `status === 'ok'` AND `probe.result === 'ok'` AND a
  valid ISO `probe.time` (round-trip rule above). The schema additionally refuses a
  `status: 'ok'` route whose probe is not a successful one with a valid ISO time. Review and
  listing use the same function.
- A response is accepted only in one fixed shape: an object with
  `choices[0].message.content` a non-empty string and `finish_reason === 'stop'`, decoded with
  the strict reader (invalid UTF-8, duplicate JSON keys and non-ok HTTP statuses refused).
  Everything else is a route failure with a fixed code (`HTTP_<status>`, `TIMEOUT`,
  `BAD_RESPONSE`, `TRUNCATED`, `EMPTY`, `OVERSIZE`, `NO_KEY`, `ENDPOINT_REFUSED`), never
  response text - in probe and review.
- Every request has ONE whole-request deadline (default 120 s; `AbortSignal.timeout` around the
  fetch and the body read, and the whole send raced against the same deadline): a deadline
  during the body read is `TIMEOUT`, never `BAD_RESPONSE`. `redirect: 'error'`: a redirecting
  endpoint is a `BAD_RESPONSE` failure, never a send onward.
- The response body is read through a size cap of 256 KiB; a body beyond it is the fixed
  failure `OVERSIZE` and the stream is cancelled, so an endpoint cannot pump unbounded bytes.
- One order in review: `usable()` first; the send under the whole-request deadline; the capped
  body read; the registry update FIRST (failure or success) under the one writer; only then the
  advisory file. A failure to write the advisory file never skips the registry update and never
  throws past it.
- `probe` writes `probe.time`, `probe.result`, `probe.note` and `status` after one tiny request
  per route, through the one writer. `status: 'ok'` can only ever be written by a successful
  probe of that route; a review failure writes only `failing` and never touches the probe fields.
- The review input excludes NOTHING silently (rule R4): JSON files are review input like
  any other file. The only skipped files are binary files, files whose diff exceeds the
  per-file cap of 20000 bytes, gitlink changes (rule E2) and files under a
  fixed-policy exclude, and each skipped path is listed with its reason in the payload
  header, while the diff stat shows every changed file; the two fixed-policy excludes (session
  journals under `.ai/worklog/` and review files under `docs/reviews/`) are listed the same way
  when they match a changed file. The size of each file's diff comes from the per-file diff
  fetched with its literal path (`GIT_LITERAL_PATHSPECS=1` on every git call, rule R2),
  never from a pathspec match: a file named `a[1].txt` is only that file, not its glob
  neighbours. Every diff call passes `--text` together with
  `--no-textconv --no-ext-diff --no-renames --ignore-submodules=none`, so a binary attribute,
  a `-diff` attribute from any attributes file (system, global, `core.attributesFile`,
  XDG or HOME) and a diff driver `binary=true` cannot hide a text file, and a gitlink change
  (mode 160000) is never dropped, not even with `diff.ignoreSubmodules all` configured: it is
  listed in the skipped list with the reason `submodule` and its two object ids. The binary
  judgement is the tool's own: a file is binary when its diff bytes contain a NUL byte
  or fail the strict UTF-8 decode; the change records come from `git diff --raw -z
  --no-renames --no-abbrev --ignore-submodules=none` (one flat record per change). The
  fixed-policy exclude is case-folded: the path is compared after Unicode NFC
  normalisation and lower-casing, so a review path in any letter case is excluded like its
  lower-case spelling.
- The base reference is DATA, never a git option (rule R1): it must match
  `^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$` (never starts with a dash, no spaces), it is resolved
  first by `git rev-parse --verify --end-of-options REF` to a full object id, and only that
  object id is passed to `git diff`, after the options and before a literal `--`; a base that
  does not resolve refuses the run with the fixed code `PREREVIEW-BASE`, never an empty input
  reported as ok. Every review-input git call of the tool runs with an environment from which
  every inherited `GIT_*` variable is removed and with the repository given by `-C` on the
  worktree argument (rule R4; rule C2 adds the tool's own fixed `GIT_*`
  variables on top of the scrub: `GIT_LITERAL_PATHSPECS=1`, `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_ATTR_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL` pointed at an empty file of the tool's own
  temp directory), so `GIT_DIR` or `GIT_WORK_TREE` pointing at another repository changes
  nothing, and no system or global config can declare a converter; the one other git call of
  the tool, the advisory-home discovery (`git rev-parse --git-common-dir`), runs WITHOUT `-C`
  on the tool's own directory (cwd `__dirname`, the main checkout), in the plain environment
  with every `GIT_*` variable removed. A negative or non-integer `--max-diff-bytes` refuses
  with the fixed code `PREREVIEW-MAX-DIFF-BYTES` (rule R5), as does an unknown or
  missing provider with a non-empty `reasoningParams` (the fixed code `PREREVIEW-REGISTRY`,
  never a TypeError).
- The advisory output is DATA, not text: one JSON file per send, created exclusively, at
  `.ai/runtime/prereview/<UTC-stamp>-<random>.json` of the MAIN checkout - a home whose root is
  `git rev-parse --git-common-dir` of the tool's directory, run in an environment where every
  `GIT_*` variable is removed, never from a caller argument; there is no output base or
  output directory option at all (rule R3: a hostile `GIT_DIR` or `GIT_WORK_TREE` cannot
  redirect it). The home is created by the guarded creator one level at a time
  (`mkdirGuarded`, the helper of `tools/operator/auto-retire.cjs`, root check at every step)
  BEFORE any directory exists outside the root: a junction at any parent refuses before a
  directory is created. The file name is generated by the tool from a closed grammar (a UTC
  stamp and random hex), never accepted from a caller. The file holds exactly the fields
  `{schema: "prereview/1", advisory: true, mode: "READ-ONLY ADVISORY", verdict: null, route,
  createdAt, answer}`; `answer` is the model text (or a fixed failure code line) as ONE JSON
  string, so no CR, LF or U+2028 separator can start a `Verdict:` or `Mode:` line and `verdict`
  is the constant `null`: the file cannot be read as a verdict by any parser. The path is
  checked by the repository guarded path helpers (`realInside` with `refuseHardlinks`,
  case-insensitive containment on Windows, every parent checked, never a junction or a
  hardlink). Rule E3: the ONE documented override of the advisory home root is the
  environment variable `PREREVIEW_ADVISORY_ROOT` (an absolute path). It exists so every test
  and every mutant of the package gets its OWN temporary advisory home instead of the shared
  git-derived home (two test processes and the mutation harness never race on one directory);
  the default without the override is unchanged (the main checkout derived from git, never
  from a caller argument), and the guarded creator and the guarded path checks run from the
  override root exactly as from the git-derived root. Rule E4: a skipped path in the
  payload header and the model answer in the advisory file go through ONE escape function
  that turns every control character (Cc), every bidi and invisible format character (Cf),
  U+0085, U+2028 and U+2029 into the visible escape `\uXXXX`, so no raw separator and no
  invisible mark can start or spoof a line a reader or a parser judges.
- The outbound scan runs on the assembled request body (everything except the authorization
  header) on TWO surfaces: the JSON body text AND every string value of it separately, each
  after removing ONLY default-ignorable/format characters (`\p{Cf}`); newlines and every other
  character are never removed. Both surfaces use the handoff scanner `findSecretLeak`
  (`.ai/bin/protocol-hooks.cjs`) together with the shared `secretIn` (`.ai/bin/lib/secrets.cjs`).
  A hit refuses the send for that route with a fixed reason that never reproduces the matched
  value. Encodings the handoff scanner does not detect (base64, entities, percent) are outside
  the design bound.
