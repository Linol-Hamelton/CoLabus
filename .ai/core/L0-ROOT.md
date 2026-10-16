---
id: P-L0-000
version: 0.8
title: Kernel root - why the kernel exists, its invariants, and how everything else is found
layer: L0
type: invariant
status: active
owner_approval: PROTO-DEC-0061
decision: [PROTO-DEC-0061, PROTO-DEC-0070, PROTO-DEC-0079, PROTO-DEC-0081, PROTO-DEC-0082, PROTO-DEC-0083]
roles: [all]
stages: [any]
triggers: [session-start]
enforcement: S~
enforced_by: [validate-protocol.ps1, .ai/bin/protocol-handoff.cjs, .ai/bin/protocol-lock.cjs]
script_candidate: no:4
evidence_class: [A, B]
evidence: [PROTO-DEC-0041, PROTO-DEC-0044, PROTO-DEC-0045, PROTO-DEC-0047, PROTO-DEC-0050, PROTO-DEC-0054, PROTO-DEC-0060, PROTO-DEC-0070, PROTO-DEC-0079, PROTO-DEC-0081, PROTO-DEC-0082, PROTO-DEC-0083]
cost_basis: unknown
---

# Kernel root (L0)

## Purpose

`AGENTS.md` and the host project decisions take precedence. Load the records needed for your assigned role and stage; consult CATALOG for the rest. The metadata names mechanical enforcement. Requirements needing judgement remain with the assigned participant.

## Rules

### Why this kernel exists

R-L0-01. Several AI assistants work in one repository and share no memory; the filesystem
is the only channel. The kernel makes their work verifiable and keeps authority with the
human owner. The scarce resource is review rounds and owner attention, not tokens; every
rule is judged by whether it saves them.

### How the kernel is built

R-L0-02. Ten layers, loaded from this root down to the leaf you work on:
L0 root and rule-making - L1 roles - L2 procedures and scenarios - L3 tools - L4 measured
tool experience - L5 state and artifacts - L6 metrics - L7 prose documents - L8 access
expansion - L9 code. Load in full what names your role and your stage; read the CATALOG
summary of the rest. Why: loading unrelated material consumes context without helping the assigned task.

### Invariants

R-L0-03. Sources rank: approved decisions > the working tree and git > the task > the plan
> journals > the archive. When two disagree, the lower one is stale: fix it or report it.

R-L0-37. OwnerIdeas files are advisory seeds, ranked below the plan. A file leaves the active
corpus when the frame that consumes it closes (P-L0-008). Agents never place their outputs in
`OwnerIdeas/`. Why: advisory inputs must not compete with the approved source of a decided rule (PROTO-DEC-0079 item 7).

R-L0-08. Chat is not memory; what is not in the repository did not happen.

R-L0-04. Only the owner decides. An approval given in conversation is recorded by the lock
holder with its provenance. A call, a prompt or a role transfers no authority; no agent has
authority over another. Any participant may challenge any other; the disagreement is
recorded in the task's open questions and never silently overwritten. Why: authority that
can be written into a prompt can be forged, and a silenced objection is a lost reproduction.

R-L0-05. No one certifies what they authored, executed or controlled. High-risk work needs
two parallel independent certifiers. Why: independent checks can expose different defects.

R-L0-06. A reproduction outweighs any vote, rank or majority. Label claims FACT, CLAIM or
HYPOTHESIS; "measured" only with the measurement. Why: a majority does not refute a reproduction, and a measurement claim needs supporting data.

R-L0-07. Never: write another session's journal; write a secret anywhere; edit a written
decision block; approve your own proposal; delete history instead of archiving it; release
a lock you did not take without confirming its holder is gone; commit or push without the
owner; report work as verified when you did not run the check.

### How to act

R-L0-09. The files your role and stage name are the minimum you read, never the ceiling.
Reading is never forbidden. An anomaly you notice outside your set must be reported.
Why: a rule that forbids reading makes agents walk around problems.

R-L0-10. If no rule covers your next action, sources conflict, a tool is blocked, a budget
is exhausted, or the premise is wrong: stop and ask (P-L0-002). Never invent a rule or
widen a permission.

R-L0-38. An action that a recorded source already allows unambiguously, and that widens no
scope, authority or permission, is taken without asking the owner again, and its basis is
recorded; the owner is asked only in the cases P-L0-009 lists. Why: repeated confirmations make
the owner the bottleneck of every run (PROTO-DEC-0070 items 5-6, made general by 0081).

R-L0-11. Every loop has a budget: two attempts per root cause, three certification rounds
per batch, three wakes per stalled session. An exhausted budget goes to the owner or to an
audit, never to one more try. Why: a limit per cause is ineffective without the stated limits on the whole cycle.

R-L0-16. Check any source list against the repository inventory before trusting it; a
list inherited from a prompt is not verified. Why: a supplied source list can omit the primary material needed for the task.

### How the kernel changes

R-L0-12. Each rule has one home. Everywhere else it is a pointer. Why: independent restatements can diverge and give contradictory instructions.

R-L0-13. A failure is closed by changing the procedure it belongs to; a workaround only
finishes the work in hand. Record every failure as a signal.

R-L0-14. Risks are sought to cover them, not to refuse. Reject a solution only when its
risks cannot be covered at an acceptable cost.

R-L0-15. A check whose inputs are repository state, whose output is reproducible and whose
rule is already recorded becomes a script; judgement stays with models and the owner.

R-L0-17. Every kernel record is created, changed and retired through P-L0-001, with
evidence of its class: proven useful (A), harm when absent (B), predicted gain of a new rule
(C) or of a change (D), retirement (E).

R-L0-18. An accepted decision changes only through a new approved block; reopening one
needs a recorded trigger of a defined kind (P-L0-005).

R-L0-19. No layer lands, and no next layer starts, without a recorded consistency check of
the layers built so far (P-L0-004). Why: the owner directed it (PROTO-DEC-0054 item 4).

R-L0-20. A record is improved or retired only on a recorded finding (P-L0-006); disuse is never
a reason, because a layered kernel expects records to wait for their trigger.

R-L0-21. A retirement, and the kernel as a whole, are judged by a comparative test of variants on
the same tasks with one model (P-L0-007), not by opinion.

R-L0-22. Research converges: every frame ends in ACCEPT, REJECT, EXPERIMENT or DEFER within bounded
rounds and per-stream limits, and new research is never a frame's output (P-L0-008). Why: unbounded research can consume capacity without producing implementable decisions (PROTO-DEC-0082, 0083).

## Where to go next

Your role: L1 `ROLE-<slot>`. Your stage: L2. Missing rule, whether to ask: P-L0-009.
New or changed record: P-L0-001. Conflicting sources: P-L0-003. Layer consistency: P-L0-004.
Decisions and reopening: P-L0-005. Improve-or-retire candidates: P-L0-006.
Comparative tests: P-L0-007. Research frames: P-L0-008.
Use the generated CATALOG to locate the supplied records. Each record carries its own status and approval basis; inclusion in this product does not activate a draft or supersede the host project decisions.

## Evidence

- R-L0-01: PROTO-DEC-0045 item 6. R-L0-02: load only the required role and stage context.
- R-L0-04: PROTO-DEC-0030, 0043 item 2; `AGENTS.md:50-51`. R-L0-05: PROTO-DEC-0041 items 1-2,
  0047 item 3. R-L0-06: PROTO-DEC-0041 item 5, `.ai/docs/PAIRED-CYCLE.md:153`, PROTO-DEC-0051.
- R-L0-07: `AGENTS.md:459-467`. R-L0-10: P-L0-002. R-L0-11: PROTO-DEC-0046 item 4, 0047
  item 5, 0051 item 4. R-L0-16: PROTO-DEC-0044. R-L0-12: kernel discussion section 3.
- R-L0-13: PROTO-DEC-0050, 0051. R-L0-14: PROTO-DEC-0049 item 4. R-L0-15: spec section 1,
  PROTO-DEC-0047 item 8. R-L0-17: P-L0-001. R-L0-18: `AGENTS.md:311-321`, PROTO-DEC-0033.
  R-L0-19: PROTO-DEC-0054 item 4. R-L0-20, R-L0-21: PROTO-DEC-0060 item 2.
  R-L0-22: PROTO-DEC-0082, 0083. R-L0-37: PROTO-DEC-0079 item 7. R-L0-38: PROTO-DEC-0070 items 5-6, 0081.

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-09-24
- 0.4 — 2026-09-24
- 0.5 — 2026-09-26
- 0.7 — 2026-09-27
- 0.8 — 2026-10-01
