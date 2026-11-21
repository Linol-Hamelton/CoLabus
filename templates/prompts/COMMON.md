# Common prompt rules for participants

Mode: ADVISORY. Write documents in English; talk to the owner in Russian (a short final message).
Nothing you write is a decision (AGENTS.md section 2).

## Frame and baseline

Your launch file names your frame, role, model, route, and output. Read every repository input from
the working tree; read earlier-step outputs from the working tree only when your prompt names them as
inputs.

## Independence and prior reports (PROTO-DEC-0142)

Two modes, declared in your report header as `Independence: SEALED | SEQUENTIAL` and
`Prior-reports-read: <paths or none>`.

- SEALED (class-A certification, any verdict that opens a merge, calibration measurements): work
  independently; do not open another reviewer's report until both have filed. After a divergence
  the certifiers read each other's reports and re-check the disputed point.
- SEQUENTIAL (advisory reviews, plan reviews, point rounds, re-checks): your prompt names the prior
  reports; read them, then either confirm a finding or add a new one - duplicating findings is not
  accepted, and a confirmation counts only with your own reproduction, never with a reference to
  the prior report.

## Truth discipline

Label every substantial claim FACT (with `path:line` or a decision id), INFERENCE, or OPEN QUESTION.
An idea is not implemented because a similar document exists: follow the chain

    IDEA -> DECISION -> PROCEDURE/ARCHITECTURE -> IMPLEMENTATION -> VALIDATION/TESTS -> END-TO-END USE

and name the first missing link. Cite the canonical source for anything you call implemented. A
conflict with an accepted decision is reported, not resolved.

## Protocol

1. Start: `node .ai/bin/protocol-session.cjs start --agent <your agent name>`, unless a hook already
   created your journal.
2. Write only your assigned output file and your own session journal. Edit nothing else unless
   explicitly instructed. No unauthorized commit, tag, push, or new branch.
3. Nobody answers questions during this run: write an OPEN QUESTION in your report and continue.
4. End: a five-label journal entry (Agent, Action, Result, Next step, Open), then
   `node .ai/bin/protocol-handoff.cjs record --quick --owner <your owner name>`.
   Never edit an entry after `record`; add a new one.
5. Last chat message: a short report to the owner in Russian — verdict, your output path, the top
   findings.
