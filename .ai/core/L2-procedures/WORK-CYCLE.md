# Work cycle of a participant — the owner's narrative mapped to procedures

This is a navigation map, not an additional source of rules. Every step points to the procedure that owns the requirement; use those records and the current task scope when executing the cycle.

## The cycle

| # | Owner's words (paraphrase) | Home | Artifact | State |
|---|---|---|---|---|
| 0 | The task is assessed and the model and effort are chosen before launch | P-L2-002 (R-L2-002.1, .4) | `tier` in the task frame | trial |
| 1 | The executor receives its role in the prompt | P-L2-006 dispatch; SCHEMA-assignment | packet; role line | pending (stage 3); draft |
| 2 | It understands where it is, its rights, duties and limits | P-L1-001 steps 1-6; ROLE-`<slot>` | `Launch:` and `Orientation:` lines | draft |
| 3 | It receives tools, criteria of success and bounds | P-L2-001 task frame and environment manifest | `task-frame`, `environment-manifest` | pending (stage 3) |
| 4 | It checks the complexity against its launch | P-L1-001 step 7; R-L2-002.5 | `Tier-mismatch:` line when they differ | draft; trial |
| 5 | It works by the standard procedure, checkpoint after each block | P-L2-003 execute | journal, tree | pending (stage 3) |
| 6 | It records the process and the cost | P-L2-003; L6 metrics M-001..M-009 | cost fields of the journal entry | pending (stages 3, 5) |
| 7 | It hands the work to review | P-L2-004 accept; P-L2-008 freeze | candidate package | pending; trial |
| 7a | Standard cycle: after the reviewer's PASS or RECOMMENDATION the work goes to a certifier, whose PASS approves it and whose FAIL or RECOMMENDATION sends it to the owner | R-L1-reviewer.4, R-L1-certifier.4 | certifier's verdict | draft |
| 7b | Kernel work: after the reviewer's PASS or RECOMMENDATION the stage goes to the owner | R-L1-reviewer.4; R-L0-19 | owner's decision block | draft; approved (stage 1) |
| 8 | It does not wait for the reviewer: it designs the next stage, lands nothing, at most two stages in review; what is under review is frozen | P-L2-009 pipelined review (freeze:  section 9 rule 7, CB-11) | reviewed commit SHA or path hashes in the review prompt | pending; pilot running (PROTO-DEC-0062 item 4) |
| 9 | After the cycle it checks for findings and answers them | P-L2-009 "collect verdicts"; S-005 fix round | fix response with a line per finding | pending (stage 3) |

## Reading this map

This is a navigation aid, not a kernel rule. Follow the named record and its
current metadata; the table retains inherited pending/trial annotations and
does not activate them. Model and effort are selected before launch and checked
by the executor. The two review orders are defined by the reviewer and certifier
roles. No source-author session is offered as a worked example.
