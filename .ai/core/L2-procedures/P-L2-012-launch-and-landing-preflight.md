---
id: P-L2-012
version: 0.1
title: Launch and landing preflight
layer: L2
type: procedure
status: draft
roles: [coordinator]
stages: [dispatch]
triggers: [owner-directive, stage-enter:dispatch]
inputs: [task-frame, launch-record]
outputs: [launch-record]
back_edges: []
enforcement: none
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0190]
cost_basis: unknown
---

# P-L2-012 Launch and landing preflight

Draft 0.1 through P-L0-001 (K2-INTEGRITY fix round 1, PROTO-DEC-0190, owner word 
item 3: class 2, "launch and landing mechanics, defects D13-D15 and kin", as "a preflight list in
the L2 work procedures"). Advisory until the owner approves it: the compiler never includes a
draft, and it becomes binding only by a later owner act. The rules first sat as R-L2-006.8-.13
inside the ACTIVE record P-L2-006 (owner_approval PROTO-DEC-0158), which made draft rules bind
and compile into packets without an owner act, against R-L0-17.10; this fix round moved them
here and returned P-L2-006 to its approved 0.5 text.

## Purpose

Launch and landing mechanics caused real defects in the days before 2026-10-15 (D13: an
exclusive pin on a shared runtime directory and a launcher seat with the wrong working
directory, root cause of the pair-launch flake; D14: a reused seat name reading stale terminal
state; D15: an author session ending while still waiting on a background job) together with
their kin: a certifier's flag leaking into the full suite, an archiver missing staged files,
tar reading a drive-letter path as a remote host. This record gives the launcher checks one
draft home. Enforcement by the launchers is plan step R of the unified plan; this record
drafts the text only.

## Rules

- R-L2-012.1. Before a seat launches, the launcher refuses a seat name already present in the live seat table and archives the previous seat's terminal state (path and digest) before any reuse (prevents a reused seat name reading stale terminal state, D14; a launcher checks it by comparing the seat table and refusing on collision).
- R-L2-012.2. An author session is launched foreground-only: its prompt forbids background jobs, and a session that ends while a job it started is still waited on is a launch defect (prevents an author session ending while waiting for a background job, D15; a launcher checks it by refusing detached spawns for author roles and refusing session end with live children).
- R-L2-012.3. A launcher takes no exclusive pin on a directory another seat may share: a pin is seat-scoped, or taken only after a bounded wait that names the holder (prevents exclusive directory pin collisions, D13, PAIR-FLAKE-RCA; a launcher checks it by refusing a pin on a shared runtime directory and by naming the holder in every pin failure).
- R-L2-012.4. The environment of the full suite is built from a declared allowlist, not inherited from the launching seat, so a certifier's flags (for example PROTOCOL_NO_FULL_SUITE) never silence suite checks (prevents a certifier flag leaking into the full suite; a launcher checks it by diffing the suite environment against the allowlist before the run).
- R-L2-012.5. An archive or landing step includes every staged file: the staged paths are compared against the archive index before the step is declared done (prevents an archiver missing staged files; a launcher checks it by refusing an archive index that lacks a staged path).
- R-L2-012.6. An archive command on a Windows drive path runs in local mode (tar with `--force-local`, or an equivalent flag of the tool in use) (prevents tar reading `D:` as a remote host; a launcher checks it by scanning the command line of every archive invocation that carries a drive-letter path).

## Steps

1. **Preflight the launch** (coordinator). Refuse a seat name collision and archive the previous terminal state (R-L2-012.1); launch author sessions foreground-only with the no-background-jobs prompt (R-L2-012.2). Input: the task frame. Output: the launch decision.
2. **Hold the pin and environment discipline** (coordinator). Refuse an exclusive pin on a shared directory, or wait a bound and name the holder (R-L2-012.3); build the suite environment from the declared allowlist and diff it before the run (R-L2-012.4). Input: the launch environment. Output: the checked environment.
3. **Preflight the landing** (coordinator). Compare the staged paths against the archive index before declaring the step done (R-L2-012.5); run archive commands in local mode on drive paths (R-L2-012.6). Input: the staged files. Output: the landing record.

## Stop conditions

- A launcher cannot check a rule (the check is recorded as an open question for the owner; the rule is never silently skipped).
- A rule collides with an active record (stop and go to P-L0-002; the draft never overrides an approved text).

## Back edges

None; the preflight runs before and after the dispatch of P-L2-006 and changes none of its rules.

## Evidence

- A - the real launch and landing defects the rules prevent (D13 the pin and working-directory collision behind the pair-launch flake, PAIR-FLAKE-RCA; D14 seat-name reuse; D15 a background-waiting author session), recorded in the K2-INTEGRITY author report and the sealed reviews of 2026-10-15. Cost: unknown in attempts.
- B - the launcher checks as drafted text (this record; enforcement by the launchers is plan step R). Cost: unknown.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Read as binding before the owner act | medium | high | status draft; the compiler never includes a draft | none | a reader who skips the status |
| Launchers never implement the checks | medium | high | plan step R names the enforcement; this record is the checklist | plan time | a launcher that ignores it |
| The rules drift from the launchers | medium | medium | each rule names its launcher check | review time | an untested launcher path |

## Change log

- 0.1 — 2026-10-15
