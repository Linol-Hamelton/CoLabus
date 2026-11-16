---
id: P-L3-004
version: 0.10
title: Route failover - the maker's CLI first, resolver or owner substitutes, liveness first
layer: L3
type: procedure
status: active
roles: [coordinator, dispatcher]
stages: [dispatch, execute]
triggers: [dispatch, route-failure]
inputs: [task-frame, .ai/core/L3-tools/trial/MODEL-MATRIX.md, .ai/core/L3-tools/kilo-routes.json, .ai/docs/clients.json, docs/ops/model-ladder.json]
outputs: [journal, signals]
back_edges: [4>2/1/owner]
enforcement: S~
enforced_by: [.ai/bin/protocol-dispatch.cjs, .ai/bin/protocol-failover.cjs]
script_candidate: yes
evidence_class: [B, C]
evidence: [PROTO-DEC-0049, PROTO-DEC-0050, PROTO-DEC-0065, PROTO-DEC-0067, PROTO-DEC-0068, PROTO-DEC-0070, PROTO-DEC-0075, PROTO-DEC-0076, PROTO-DEC-0079, PROTO-DEC-0146]
cost_basis: unknown
owner_approval: PROTO-DEC-0159
decision: [PROTO-DEC-0067, PROTO-DEC-0070, PROTO-DEC-0075, PROTO-DEC-0076, PROTO-DEC-0146, PROTO-DEC-0148, PROTO-DEC-0159]
supersedes: []
---

# P-L3-004 Route failover

The route-failover contract is implemented in part by `.ai/bin/protocol-dispatch.cjs` and `.ai/bin/protocol-failover.cjs`. The metadata states the current enforcement and approval basis; `.ai/docs/CLI-AGENTS.md` describes the dispatcher interface.

## Purpose

A task is launched with a model and an effort chosen by P-L2-002. The route to that model can
fail: limits run out, authorisation lapses, a provider is down. This procedure decides when a
route has failed, which route replaces it, and when no automatic replacement is allowed. The
two costs it balances are killing a long but working agent, and losing time on a dead one. A
third cost it never accepts is two executors doing one task.

## Rules

- R-L3-004.1. The primary route of a model is its maker's official CLI as the model matrix
  records it. A maker without a CLI has the route the matrix names (DeepSeek: Kilo, with the
  owner's own key).
- R-L3-004.2. When the primary route is unavailable, Kilo is the fallback router. Within Kilo, the
  cheapest suitable route of the same model is taken, by output price and then input price, as
  the recorded Kilo catalog gives them. Ties go to the maker's own provider, then alphabetically
  by provider (the tie-break is the implementer's proposal, not the owner's words).
- R-L3-004.3. A route is suitable when:
  - its model is active and can call tools;
  - it can set the effort of the tier. That is the level the primary cell names or, failing that,
    the lowest higher level the route offers, which counts as a stronger route.

  A route that cannot reach the level, or cannot set any effort when the cell names one, is not
  suitable. Only pinned model ids are used: no `-latest` aliases, no `-fast` or `-pro` serving
  variants. Where the primary cell's effort is unknown, the level is the tier's position (minimum,
  middle, maximum) in the route's own list, by PROTO-DEC-0059 items 3-4.

> R-L3-004.2-3 are suspended while PROTO-DEC-0076 item 1 holds: every model call goes through a
> maker's CLI, the approval-gated DeepSeek rung is the only exception, and Kilo is not a fallback
> router.

- R-L3-004.4. Recovery after a classified failure follows PROTO-DEC-0075 items 2-4: the action
  follows the failure class, every new attempt has a stated reason, and a known-failing
  operation is never repeated. The budget is the first attempt and one retry on the primary,
  two attempts on each of two substitutes, at most six fresh invocations in all, with resumes
  counted apart. The substitutes are the resolver's (0075 item 10) or the owner's `fallback`
  routes. The one automatic Kilo attempt of 0.5 is withdrawn.
- R-L3-004.5. After useful work has started, a crash or a stall is resumed first (0075 item 2).
  A fresh executor starts only when the resume path is exhausted and the budget of R-L3-004.4
  allows it, and only after the previous process tree is confirmed gone (R-L3-004.7).
- R-L3-004.6. A stall is judged by progress signals: no progress for the step's stall interval
  (default 10 minutes; a dispatch file may set 5-120). The hard ceiling per step (default 120
  minutes) runs from the step's first launch and progress does not reset it: a heartbeat never
  keeps a looping step alive (0075 item 5). A stalled session is woken by resume up to three
  times before it is recorded as fallen (0051 item 4).
- R-L3-004.7. A task never has two live executors. A new route starts only after the previous
  process tree is confirmed gone, and a running record blocks a second start. A start is refused
  while the previous watchdog lives, or while any process the job's record names is alive by
  identity (each attempt's root and recorded descendants, and their children), whatever state the
  record was left in: a dead watchdog does not release the job. Running the
  primary and the fallback in parallel needs an explicit owner decision. A process is
  identified by its PID together with its creation time, and nothing is stopped by a PID alone:
  Windows reuses PIDs, and the parent id of a live process can name a long-dead parent. A tree is
  stopped leaf first: each descendant by its PID only right after its identity was confirmed in a
  fresh process table, the root through the dispatcher's own child handle, and never by a tree
  kill that selects children by parent linkage (`taskkill /T`). The tree is first recorded one and
  three seconds after the spawn, then on every tick. A watchdog that died before its attempt
  settled blocks every new start until the owner's stop settles that attempt, because processes it
  never recorded cannot be named later by any process table; the stop warns when the attempt was
  never scanned.
- R-L3-004.8. Reaching the hard ceiling of R-L3-004.6 is TIMEOUT: the step is BLOCKED and the
  session is never resumed (0075 items 3, 5). The idle and hard caps of PROTO-DEC-0050 item 2
  stand in this form.
- R-L3-004.9. Isolation and scope (PROTO-DEC-0070). The owner named the terms; this mechanism is the
  implementer's reading of them.
  - The copy. Each attempt runs in a disposable private clone of HEAD (`git clone --shared`)
    under `<system temp>/colabs-research/`, with the research package copied in, and that clone is
    the executor's working directory. A clone, unlike a linked worktree, shares no config, refs or
    hooks with the checkout. It has no remote. Under the kernel dispatcher the clone lives under
    `<system temp>/colabs-dispatch/`, and the git mode is read from the slot's `git` key in the
    dispatch file.
  - Push. The rule `url.no-push://blocked.insteadOf` with an empty value is set in the executor's
    environment and in the clone's own config. It blocks every direct URL form: existing remotes,
    added remotes, explicit URLs, explicit push URLs and typed URLs. A network fetch fails too.
    A longer `url.*.insteadOf` given through `-c` (command scope) or an ambient file supersedes
    it (longest prefix wins). `GIT_CONFIG_NOSYSTEM=1` and an empty launcher-owned
    `GIT_CONFIG_GLOBAL` remove the ambient-file source. The `-c` form remains a residual that only
    the audit covers.
  - Credentials, Level 1 (PROTO-DEC-0077 item 3). The executor's environment is built without git
    credential vectors: `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_ASKPASS`, `SSH_ASKPASS`,
    `SSH_AUTH_SOCK`, and `*_TOKEN` and `*_PAT` names that mention GH, GITHUB or GIT. It also gets
    an empty `credential.helper`, `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never`. Model
    clients keep their own keys in their config files.
  - Git mode, default-deny. Each job's `git: {mode, target?, publishRequired}` is read only from
    `prompts/jobs.json`, never from the job. `READ_ONLY` runs. `LOCAL_COMMIT` needs an
    authorisation naming the decision that permits commits; none exists today. `BRANCH_PUSH` and
    `RELEASE_PUSH` fail closed with "publisher not implemented". No publisher exists.
  - Audit, never enforcement. Before and after every attempt, the launcher records `git ls-remote`
    of each remote configured in the checkout (the owner's repositories only). A change in a
    no-push mode is an incident: it invalidates the attempt, nothing is copied back, and the clone
    is kept. The audit is blind to:
    - a transient push that is reverted;
    - an after-query that fails, which is recorded as `unverified`, not as an incident;
    - webhook and CI side effects;
    - remotes outside the configured list.
  - The scope check. It runs on every tick and again before the copy back. It compares the working
    files, HEAD, every ref, the clone's config and its hooks with the state at preparation. Any
    change other than the job's outputs and new journals stops the job at once (`SCOPE_STOP`).
  - The launcher's own git calls run with `core.fsmonitor=false` and, per call, `core.hooksPath` set
    to a random path that does not exist, under a private temp directory. No hook file exists to
    run. An adversarial job that predicts the path inside the call window is outside the
    threat model.
  - `index.lock`. A held lock makes the state unreadable. The read retries 5 times over about 4 s.
    If the lock persists and a git process works in the copy, the tick waits for the next scan. If
    none does, the attempt stops with "stale index.lock", nothing is copied back, and the clone is
    kept. The lock is never deleted.
  - The job table is `prompts/jobs.json` (PROTO-DEC-0073), with a strict loader: unknown keys or a
    missing field fail closed.
  - The copy back. When the tree is gone, only the job's outputs and new journals are copied back
    into the checkout.
  - What the check does not read. Git-ignored paths (`.ai/runtime/`, scratch) are not read. They
    are never copied back and are deleted with the clone.
  - Lifecycle. A settled clone is deleted. A clone kept by `SCOPE_STOP`, or left by a watchdog
    that died, stays under `<system temp>/colabs-research/` until the owner removes it.
  - vibe runs with `--trust`, which only skips the trust prompt for the clone. It adds no tool.
- R-L3-004.10. Before the first attempt the dispatcher pins HEAD, the launch file and every
  copied-in file by sha256, and the dispatch file version. A pinned input that changes blocks
  the next attempt, or the owner starts a new launch revision; a HEAD change alone does not block
  (0075 item 7).
- R-L3-004.11. Two failure rules with different scopes (PROTO-DEC-0148 item 2). The dispatcher
  (`.ai/bin/protocol-dispatch.cjs`) follows R-L3-004.4. Manual launches of the operator follow
  PROTO-DEC-0148 item 2: the third consecutive failed invocation of the current action switches
  the work to the duplicate executor of that action. Every fall - a dispatcher
  stall recorded as fallen by R-L3-004.6, and a switch of the manual rule alike - is appended by
  the failover journal writer (`.ai/bin/protocol-failover.cjs`) as one event to the per-machine
  failover journal `.ai/runtime/executor-failover-<machine>.jsonl` (PROTO-DEC-0174 item 5: a
  machine id in journal names, so two machines never append to one file). The event carries the
  route, the reason class, the time, the attempt, and the next route taken only from the
  resolver's recommendation, never chosen by hand. The writer records and recommends only: it
  never chooses a model and never runs one, and a slot without an explicit route stays at
  ASK_OWNER. The conflict of PROTO-DEC-0148 item 3 (Kilo as the universal duplicate) with
  PROTO-DEC-0076 item 1 (Kilo is not a fallback route) is not resolved by this record; it stays
  an open owner question.

## Steps

1. **Resolve** (dispatcher). Take the task's primary route from the model matrix. Then order the
   Kilo candidates from `kilo-routes.json` by R-L3-004.2-3, each with its effort level or the
   reason it is unsuitable. While PROTO-DEC-0076 item 1 holds, only the maker-CLI route is
   selected; the Kilo ordering of R-L3-004.2-3 is not executed.
2. **Launch** (dispatcher). Start the route with one fixed ASCII line naming a prompt file
   (PROTO-DEC-0050 item 2). Record the route, the level, the process id, and a baseline of the
   task's files and the agent's journals.
3. **Watch** (dispatcher). Every tick, read the liveness signals and apply the state table below.
4. **Recover** (dispatcher). On a classified failure, act by R-L3-004.4-5 and the class table of
   `.ai/docs/CLI-AGENTS.md` section 9.
5. **Hand off** (dispatcher). A BLOCKED or FAILED step writes its run record and the report of
   the work done (PROTO-DEC-0076 item 3); the owner decides.

### Liveness signals

| # | Signal | Counts as progress | Counts as useful work |
|---|---|---|---|
| L1 | the process is alive | no, it only allows waiting | no |
| L2 | bytes of stdout and stderr | growth with at least one new line that is neither an error text nor a retry notice | 16 KB or more in total, while the log carries no error text |
| L3 | the client's own log files, where the client writes them | any growth, except in a tick whose new L2 lines are all error or retry lines | no |
| L4 | the task's output files (size, time) | any change | any change |
| L5 | journals of the task's agent created after the launch | creation or growth | creation |
| L6 | CPU time of the process tree | 0.5 s or more per tick | no |
| L7 | the set of child processes | a command started or ended | no |

A hard failure is one of:
- a non-zero exit before useful work;
- an exit without useful work;
- before useful work, an error text in L2 followed by soft silence. The error texts are: the
  status codes 401, 403, 429, 500, 502, 503, 504 and 529, but only after an HTTP, status, error or
  code word or before their reason phrase (a bare number is normal output); authorisation
  errors; a rate limit, quota, credit or usage limit reached; a model not found or unavailable;
  network, provider and overload errors (`ERROR_TEXT` in the launcher, probes in its self-test).

### State table

For new dispatches, apply R-L3-004.6 and the dispatcher states specified by
PROTO-DEC-0075 item 11. The interface is described in `.ai/docs/CLI-AGENTS.md`
section 9. Earlier launcher timer tables do not define the current dispatch contract.

## Stop conditions

- Every `NEEDS_OWNER`. The owner may start a named route explicitly. Where outputs already exist,
  the dispatcher requires an explicit takeover by the owner (R-L3-004.7).

## Back edges

- `4>2/1/owner`: the budget of R-L3-004.4 on the primary and the substitutes; when it is spent,
  the owner (PROTO-DEC-0050 item 2). Kilo is not an automatic route while PROTO-DEC-0076 item 1
  holds.

## Evidence

- B - decision basis: PROTO-DEC-0049 item 3, PROTO-DEC-0050 item 2 and
  PROTO-DEC-0065 item 2. Cost remains unknown; no incident measurements are
  supplied by this product document.
- C - policy basis: PROTO-DEC-0067. Signal thresholds, price tie-break, caps,
  tick interval and smoke timeout are implementation choices under that policy,
  not additional owner instructions. The owner may replace those values.
  Product inclusion does not extend a trial, activate a new route or certify a measurement.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A long silent command is taken for a hang | medium | high | CPU and child signals L6-L7 count as progress; hard timer 8 min | slower detection | a command that waits without CPU for more than 8 min |
| A retry loop after a provider error looks like work | medium | medium | log volume is not useful work while the log carries error text; new log lines that are all error or retry lines are not progress (L2, L3), so the loop reaches soft silence: before useful work a hard failure, after it `SUSPECT` then `HUNG` | one soft wait | a loop that is silent on stdout while its client log grows, or that starts a process per retry (L7) |
| An unrelated process is stopped | low | high | identity by PID and creation time; descendants must be younger than their parent | one process-table read per tick | none known |
| An error text appears in normal output before work starts | low | medium | switch only after soft silence as well | one wrong fallback | the owner sees it in the state file |
| The Kilo fallback spends money | medium | low | one attempt; the cheapest suitable route; the owner's own providers first when prices tie | route price | a costly model on its cheapest route |
| Two executors on one task | low | high | R-L3-004.7: confirmed-dead check, running record, a start refused while any recorded process lives or while an attempt of a dead watchdog is unsettled, takeover only by the owner | one process-table read per start | a descendant no scan saw before the watchdog died: the owner's stop cannot name it and warns; under load one process-table read took seconds on Windows, so the first three seconds after a spawn can pass without a record |
| An executor writes outside its scope | medium | high | R-L3-004.9: a private clone per attempt (its config, refs and hooks are its own), a scope check on every tick and before the copy back that covers files, HEAD, refs, config and hooks, only outputs and new journals copied | one clone per attempt, three git calls per tick | a shell command writing by absolute path outside the clone, for example into the checkout itself, is not seen by the check; the owner's `git status` and `git remote -v` after the run and the certifiers' diff review cover it |
| An executor pushes | low | high | the no-push rule in the environment and in the clone's config blocks every direct URL form; the executor has no git credential in its environment (Level 1); the job's git mode is READ_ONLY and push modes fail closed; `ls-remote` before and after each attempt turns a remote change into an incident (verification of the no-push boundary is required) | a network fetch also fails; clients that call git lose `user.name` and `safe.directory` | a `-c` `insteadOf` push with credentials reachable outside the environment (OS store, SSH agent, sibling process); a hosting-API mutation; a transient push that is reverted. These are UNPROVED in the hostile suite, and that finding stays OPEN - HYPOTHESIS UNDER VALIDATION (PROTO-DEC-0077 item 3). Local cooperative mode is assumed |
| A legitimate client file stops a job | low | medium | none: a file the client creates in its working directory (a cache or a config) is outside the scope and stops the job | a relaunch | the reason names the path; the owner decides |

## Change log

- 0.1 — 2026-09-25
- 0.2 — 2026-09-25
- 0.4 — 2026-09-25
- 0.5 — 2026-09-26
- 0.6 — 2026-09-26
- 0.3 — 2026-09-25
- 0.7 — 2026-10-04
- 0.8 — 2026-10-04
- 0.9 — 2026-10-05
- 0.10 — 2026-10-11
