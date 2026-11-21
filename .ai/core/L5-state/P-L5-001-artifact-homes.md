---
id: P-L5-001
version: 0.5
title: Artifact homes and hand-over between participants - one home, one writer per instance
layer: L5
type: procedure
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [all]
stages: [any]
triggers: [dispatch, session-end, record-change]
inputs: [journal, CATALOG, record-draft]
outputs: [journal]
back_edges: []
enforcement: S~
enforced_by: [.ai/bin/protocol-lock.cjs]
script_candidate: no:4
evidence_class: [A, B]
cost_basis: unknown
evidence: [AGENTS.md:269, PROTO-DEC-0028, PROTO-DEC-0029, .ai/core/RULE-MAP.md:63, .ai/core/RULE-MAP.md:64]
---

# P-L5-001 Artifact homes and hand-over

Draft of the unified-completion record set (PROTO-DEC-0185 item 2), written through the
P-L0-001 lifecycle; binding only by a later owner act. It carries the stage-1 trial
 (one writer for the shared
documents) forward under the same id, and it is the home of RULE-MAP rows AR-043 and AR-044.
`enforcement: S~`: the shared-document lock is executed by `.ai/bin/protocol-lock.cjs`;
whether a holder is really gone stays judgement, so `script_candidate: no:4`.

## Purpose

Sessions and branches do not share memory; what passes between them is an artifact at a
repository path. When a home is ambiguous or a second writer takes an instance, one
participant's work silently replaces another's. This record gives every artifact one home
and one writer per instance, and makes the shared documents writable by one session at a
time through the cooperative lock.

## Rules

- R-L5-001.1. Every artifact of the cascade has exactly one home, its canonical repository path, and exactly one writer per instance; readers are many, and a global directory such as `.ai/worklog/` or `docs/reviews/` holds many instances, each with its own single writer (R-AH-1). [not mechanically enforced]
- R-L5-001.2. Participants and branches hand over artifacts at their homes, never each other's internal rules or chat memory; the artifact at its home, not a conversation, is the unit of exchange between two participants. [not mechanically enforced]
- R-L5-001.3. The artifact-id registry stays with its preliminary home, procedure.schema.md section 2.1, until an owner act moves it to this layer; a new id is issued only through P-L0-001, never by using it first. [not mechanically enforced]
- R-L5-001.4. A shared document (TASK, PLAN, DECISIONS, ARCHIVE, REGISTRY) is written by one session at a time through the cooperative lock `protocol-lock.cjs`; a lock held by another owner is never taken over, and its holder is confirmed gone before any release (AGENTS.md:267-304). [not mechanically enforced]
- R-L5-001.5. Per shared file: DECISIONS, ARCHIVE and REGISTRY are append-only; TASK is edited by replacing sections; PLAN is replaced by the session that owns the task (AGENTS.md:296-304; the DECISIONS and REGISTRY rows of P-L0-005). [not mechanically enforced]
- R-L5-001.6. Reading an artifact, shared or not, never needs the lock. [not mechanically enforced]

## Artifact homes

The homes table (preliminary registry of procedure.schema.md section 2.1; the L5-min
registry row format). One writer per instance; the
writer column names the producing role or tool, the id column the registered artifact id
where one exists.

| Artifact | Home | id | Writer (one per instance) | Reader | Schema / check |
|---|---|---|---|---|---|
| task frame | the frame file of a task (`docs/research/FRAMES.md` registry) | task-frame | coordinator (P-L2-001) | all; dispatcher reads the tier | task-frame.schema.md; frame lint |
| environment manifest | beside the task frame | environment-manifest | coordinator (P-L2-001) | dispatcher, certifier | environment-manifest.schema.md |
| orientation line | the `Orientation:` line of a session journal entry | orientation-line | the session | reviewer | P-L1-001 grammar |
| candidate package | review header in `docs/reviews/`; compiled packets in `.ai/runtime/packets/` (disposable) | candidate-package | the reviewing session of its own file; the packet compiler of its own packet | certifiers | bytes identical for both certifiers |
| evidence | the Evidence block of a journal entry | evidence | `protocol-handoff.cjs record` only | verify, gate-check | SCHEMA-evidence; digest, entry hash |
| findings ledger | findings table in a review file | findings-ledger | the review's own session | `protocol-verdict.cjs` | findings grammar; exit 2 |
| attempt results | `docs/ops/RUNS.jsonl` (channel RUNS) | run-record | `protocol-dispatch` only | stop-rule check; statistics by explicit channel join | run-record/1 schema |
| launch record | the tracked launch journal of the benchmark catalog (channel LAUNCHES) | launch-record | the tracked launch writer `docs/ops/launch-record.cjs` | launch statistics (advisory) | launch-record/1 schema |
| signals | `.ai/SIGNALS.md` | signals | `protocol-signals.cjs add` only | coordinator | signals ledger grammar |
| journal | `.ai/worklog/<session>.md` | journal | its own session | all | five labels, markers, entry hash |
| stop question | the owner card of a stopped session | stop-question | the stopping session | owner | five blocks of P-L0-002 |
| catalog | `.ai/core/CATALOG.md` (derived) | CATALOG | `protocol-core.cjs catalog` | all | source hash, `--check` |
| decisions index | `.ai/runtime/decisions-index.md` (derived, disposable) | decisions-index | `protocol-index.cjs` | all | source hash |
| review report | `docs/reviews/<report>.md` | review-report | its own session | implementer, owner | header, verdict |
| record draft | a draft record under `.ai/core/<layer>/` (through P-L0-001) | record-draft | procedure-author | reviewer | `protocol-core.cjs lint` |
| task intake record | the intake entry of S-001 node 1 | task-intake-record | coordinator or owner (intake) | P-L2-001 | non-empty |
| owner card | the card file of a stop question (the owner-card form) | owner-card | the asking session | owner | the owner-card form |
| owner words | the tracked append-only journal in `docs/ops/` | owner-words | the owner-words writer only | all | the owner-words form |

The two channels RUNS and LAUNCHES are never mixed; a comparison across them is an explicit
join on the channel mark (PROTO-DEC-0145 item 1). The registry row of TOOL records and the
tool registry artifact id stay in the preliminary registry until R-L5-001.3's owner act.

## Steps

1. **Name the artifact** (any role). Find the row of the homes table for what you are about to write; a deliverable without a home row is a stop condition. Input: the table above. Output: the named home in the journal.
2. **Write at the home** (the writer of that instance). One instance, one writer; a second writer of the same instance is a stop condition, not a negotiation. Input: the artifact. Output: the artifact at its home.
3. **Take the lock for a shared document** (lock holder). `node .ai/bin/protocol-lock.cjs acquire --owner <session>`; edit only what the task needs by the per-file rule; `release --owner <session>` before the session ends. Input: the shared document. Output: the edited document and the lock line in the journal.
4. **Hand over** (any role). Point the next participant at the artifact's home and its id; the next session reads the artifact at the home, never the handing session's chat or memory. Input: the artifact. Output: the pointer line in the journal or the frame.

## Stop conditions

Stop and go to P-L0-002 when:
- an artifact you must write or hand over has no home row and no issued id;
- the id you need is registered as PROPOSED and not yet issued;
- a lock holder cannot be confirmed gone, or the edit would rewrite an append-only file.

## Back edges

None.

## Evidence

- A - the first pilot: two sessions worked in parallel with the lock held and no collision; the lock was hardened by PROTO-DEC-0028 and 0029 (abandoned gates, stale reporting).
- B - the homes table closes the ambiguity measured in the L5-min work: one writer per instance (R-AH-1). Cost: unknown.
- A - RULE-MAP rows AR-043 and AR-044 name this record as the home of AGENTS.md sections 6 (`.ai/core/RULE-MAP.md:63-64`); the trial record carried the same rules.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A participant edits a shared document without the lock | medium | high | cooperative rule; the validator and review catch conflicts after the fact | none | the lock is not an OS barrier |
| A proposed id is used before it is issued | medium | high | R-L5-001.3; lint refuses unregistered ids in inputs/outputs | none | prose use outside the frame |
| The homes table is read as the issued registry | low | medium | R-L5-001.3 keeps the preliminary registry as the registry until the owner act | none | a reader who skips the rule |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15

- 0.4 — 2026-10-15
- 0.5 — 2026-10-16
