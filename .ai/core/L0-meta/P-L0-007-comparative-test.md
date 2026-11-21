---
id: P-L0-007
version: 0.6
title: Comparative test of kernel variants - A/B for a retirement candidate, A/B/C for the whole kernel
layer: L0
type: procedure
status: active
owner_approval: PROTO-DEC-0158
decision: [PROTO-DEC-0061, PROTO-DEC-0158, PROTO-DEC-0160]
roles: [coordinator, implementer, reviewer]
stages: [any]
triggers: [retirement-candidate, program-exit, owner-directive]
inputs: [task-frame, journal, findings-ledger]
outputs: [review-report, journal]
back_edges: [5>3/1/owner]
enforcement: P
script_candidate: no:4
evidence_class: [C]
evidence: [PROTO-DEC-0060, PROTO-DEC-0039, PROTO-DEC-0047]
---

# P-L0-007 Comparative test of kernel variants

The record metadata declares its status, applicability and approval basis.

## Purpose

A record is retired, and the new kernel is judged, by running the same work with and without it,
not by opinion. Two uses share one method:
- **A/B** for a retirement candidate of P-L0-006: A the kernel with the record, B the same kernel
  without it;
- **A/B/C** after the work on the kernel (PROTO-DEC-0060 item 2): A the new kernel, B the old
  kernel, C no kernel at all.

## Rules

- R-L0-21.1. All variants run the same tasks, with the same model and the same effort, each in its
  own fresh clone of the same repository at the same starting commit.
- R-L0-21.2. For the whole-kernel test, two or three tasks are run with one model in a clone of
  some repository, as the owner set it.
- R-L0-21.3. Tasks, their success criteria and the measures are written down before the first run
  and are not changed afterwards.
- R-L0-21.4. The reviewer judges each result against the success criteria without being told which
  variant produced it, where the files allow that.
- R-L0-21.5. The test reports; the owner decides. A retirement goes ahead only when variant B is
  not worse than A on any measure the owner named as decisive.

## Steps

1. **Plan** (coordinator). Write the test frame: variants, repository and starting commit, the
   two or three tasks with success criteria, the model and effort (P-L2-002; one model for all
   variants), the measures below, and the budget.
2. **Prepare** (coordinator). One clone per variant. A and B for the whole-kernel test: the new
   kernel as landed, and the kernel at the baseline commit that the coordinator names for the test; C: the same clone with every protocol file
   removed (`AGENTS.md`, `CLAUDE.md`, `.ai/`, `.claude/`, `.codex/`, protocol scripts).
   For a retirement A/B: the current kernel, and the same kernel with the record and its pointers
   removed.
3. **Run** (implementer, one session per variant and task). Launch with the planned model and
   effort; work each task to its end or its budget.
4. **Measure** (coordinator). For each variant and task:

| Measure | Source |
|---|---|
| task met its success criteria (yes / partly / no) | reviewer's verdict against the frame |
| defects the reviewer found; defects found later (escapes) | findings ledger |
| owner interventions and stop-questions | journal |
| elapsed time; tokens or cost | journal, M-007 |
| context loaded before work started | M-006 |

5. **Compare** (reviewer). One table, variants side by side. If two variants differ by less than
   the difference between two runs of the same variant would plausibly give, say so. A task whose
   run failed for a reason outside the variant (a client crash, a quota) is re-run once (back edge
   5>3); a second failure goes to the owner.
6. **Report** (coordinator). The table and the reviewer's reading go to the owner in
   `docs/reviews/`. For a retirement A/B, the owner decides whether P-L0-001 retires the record.

## Stop conditions

- The tasks or measures would have to change after a run started: stop and re-plan, all variants.
- A variant cannot be built (for example the old kernel does not install in the chosen repository).

## Back edges

- `5>3/1/owner`: a run spoiled by a cause outside the variant is repeated once; then the owner decides.

## Evidence

- C - PROTO-DEC-0060 item 2.
- PROTO-DEC-0039 item 2g set a control arm and a kill criterion for the protocol against "one task
  file and one handoff note"; C here is the same idea with no kernel at all.
- PROTO-DEC-0047 item 11 already requires paired A/B trials on one frozen SHA in separate worktrees
  for tools; this record applies that method to kernel records.
- Trial: M-009 (spread between repeated runs of one variant against the difference between
  variants), counted by hand until L6 defines it.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| Two or three tasks cannot show a small difference | high | medium | report differences against run-to-run spread; the owner decides | none | small-sample doubt |
| The same model behaves differently between runs | high | medium | same model and effort; spoiled runs repeated once | runs | nondeterminism |
| The reviewer can tell the variant from the files | high | low | judge against written criteria; say when blinding was not possible | — | — |
| Variant C leaves traces of the kernel in the clone | medium | medium | remove every protocol file listed in step 2 and check with `git status` | one check | global client settings outside the repository |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-09-27
- 0.4 — 2026-10-01
- 0.5 — 2026-10-04
- 0.6 — 2026-10-10
