# Candidate registry (template and rules) - process P-01, P-02, P-03 in docs/ops/PROCESS-REGISTER.md

The LIVE registry is the file `.ai/runtime/CANDIDATES.md` of the MAIN checkout (untracked on purpose: it changes with every SHA, and a tracked file
edited in the main tree during a suite run would trip the leak detector). Every worktree finds it through `git rev-parse --git-common-dir`, so a
session in any worktree sees the same table. If the runtime directory is ever cleaned, recreate the file from the sample below and bring the rows up to date.
Claims live beside it in `.ai/runtime/claims.json` (written only by `ops-guard claim` and `release`).

## What a row means
One row per (stream, branch, SHA). A stream is one line of work with ONE live candidate at a time (for example `f31-compiler`, `wiring`).
Columns: `stream | branch | sha | owner | status | updated | note`.
Status: `building` (the author is still changing it), `ready` (author gate done, waiting for certifiers), `certifying`, `certified`, `landed`, `void` (stopped
or contradicting an owner decision; must never be certified or merged), `superseded` (replaced by a newer SHA of the same stream).
`void` and `superseded` rows are never deleted: they are how a stale pin is caught.

## Rules
1. Whoever changes a candidate updates its row in the same minute: the old SHA becomes `superseded`, the new one `ready`. Only one live row per stream (`candidates` fails otherwise).
2. A launcher or a prompt never contains a SHA that was typed by hand from a message. It is copied from this table, and `ops-guard launch-gate --stream S --owner O <launcher> <prompt>` runs before the launch: registry valid, branch tip equals the registered SHA, a live claim of the launching owner exists, and neither file names a void or older SHA or branch of the stream.
3. `*_DONE` and `*_BLOCKED` markers are accepted only from the branch and SHA of the live row. A marker from any other branch is information, not a result.
4. Before a session or certifier is launched on a stream or worktree: `ops-guard claim --stream S --owner O --worktree W --ttl 120`. A refusal means somebody is already working there: ask, wait or let the claim expire; never start a second session on the same stream. `release` when the work ends.
5. When a candidate is stopped by order, mark it `void` FIRST, then kill the processes, then tell the streams. A stopped session may still commit; the registry, not the process list, decides what counts.
6. At the end of a stream, copy the table rows of that stream into the operator journal (history); the live file may be pruned.

## Sample (recreate the runtime file from this form if it is lost)

| stream | branch | sha | owner | status | updated | note |
|---|---|---|---|---|---|---|
| example-stream | example-branch | 1111111 | <journal owner name> | superseded | 2026-01-01 | an older SHA of the stream |
| example-stream | example-branch | 2222222 | <journal owner name> | ready | 2026-01-01 | the one live candidate of the stream |

Tools: `node docs/ops/ops-guard.cjs candidates --tips | pin-check | claim | release | status | launch-gate | register` (tests: `node --test `).
