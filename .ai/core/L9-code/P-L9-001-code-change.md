---
id: P-L9-001
version: 0.5
title: Code change - read first, stay in scope, branch, git by the owner, protected set, encodings
layer: L9
type: procedure
status: active
owner_approval: PROTO-DEC-0183
decision: [PROTO-DEC-0183]
roles: [implementer, fixer, coordinator]
stages: [execute, freeze]
triggers: [stage-enter:execute, stage-enter:freeze, scope-exceeded]
inputs: [task-frame, journal, protocol-manifest.json]
outputs: [journal, candidate-package]
back_edges: [4>3/1/owner]
enforcement: S~
enforced_by: [.ai/bin/protocol-validate.cjs, .ai/bin/validator/text.cjs]
script_candidate: yes
evidence_class: [B, C]
cost_basis: unknown
evidence: [PROTO-DEC-0046:3, DEC-0001, AGENTS.md:415-441, AGENTS.md:445-454, .ai/core/RULE-MAP.md:74-79]
---

# P-L9-001 Code change

Draft 0.1 of CORE-ARCH stage 6, task S6-T02 ( section 5). Advisory until the owner
approves it (R-L0-17.6, R-L0-17.7); the compiler never includes a draft record. It is the home of
RULE-MAP rows AR-054..AR-057 and AR-059 and the code-layer git rule that R-L2-008.4 points to; the
rules already homed elsewhere (R-L0-07 git and secrets, R-L1-implementer.1 and R-L0-10.8 scope,
R-L2-008.2 freeze paths) are pointers here, never restated. The L9 preparation of 
(branch `ops-l9-audit-claude`, not merged) measured the same ground; its figures are cited in the
S6-T02 author report.

`enforcement: S~` is for R-L9-001.7 only: the validator executes the encoding rule on the files it
owns. Every other rule is text today, and the execution map says which tool would run it.

## Purpose

Code changes went wrong in three repeatable ways: paths outside the task were touched or renamed
on the way, rules about commits and protected paths had several diverging homes (seven places for
git rules, five lists of protected paths), and encodings broke tests on another machine (29 of 105
tests failed after a CRLF patch, L9 audit X-10). This record gives the code rules one home, ties
each rule to the tool that checks it, and lists what no tool checks yet.

## Rules

- R-L9-001.1. Before changing a path, read the code at that path and the output of `git status`, and treat any change you did not make as another session's work.
- R-L9-001.2. A code change stays inside the task as R-L1-implementer.1 and R-L0-10.8 define it; a move or rename changes both of its paths, and no rename, reformatting or refactor is made that the task does not need.
- R-L9-001.3. Work larger than a small fix is done on its own branch, never directly on the main branch.
- R-L9-001.4. The paths that may change are the frame's `scope` and the paths that must not are its `forbidden`, compared as `protocol-scope.cjs checkScope` compares them: literal paths and directory prefixes, `!` exclusions, untracked files included.
- R-L9-001.5. The protected set is the one PROTO-DEC-0046 item 3 reads from `protocol-manifest.json` (every `managed` and `source` entry, plus `.ai/`, `.claude/` and `.codex/`), and a tool that keeps another list names its source.
- R-L9-001.6. A commit, a tag or a push is made only on the owner's word or a delegation that holds (R-L0-07, R-L8-001.5), and a freeze commit carries only the scope paths (R-L2-008.2).
- R-L9-001.7. Text files are UTF-8 without a byte order mark with LF line endings, and every `.ps1` file is ASCII only (DEC-0001).

## Steps

1. **Orient** (implementer). Read the paths you will change and run `git status --short --branch`; check the task's sources against `git ls-files` (R-L0-16). Input: task-frame. Output: journal line naming what was read.
2. **Branch** (implementer, or coordinator for a shared checkout). Unless the change is a small fix, work on a branch and worktree of its own. Input: task-frame. Output: the branch name in the journal.
3. **Change** (implementer). Edit only the scope paths; a move edits both paths. Input: the code. Output: the working tree.
4. **Check the scope** (implementer). Write the frame's `scope` (and `forbidden`, as `--forbidden`) as a paths file and run `node .ai/bin/protocol-scope.cjs --baseline <frame baseline> --scope <file> --forbidden <file>`; the tool lists both paths of a rename (`--no-renames`, since S6-T02 fix round 1). A failure returns to step 3 once (back edge 4>3). Input: the tree. Output: the check line in the journal.
5. **Check the encodings** (implementer). Run `node .ai/bin/protocol-validate.cjs --root .`; it must exit 0. Input: the tree. Output: the validator line in the journal.
6. **Commit** (implementer or coordinator). Commit by file names, never `git add -A`, and only on the owner's word or a delegation that holds (step 4 of P-L8-001); a freeze commit follows P-L2-008. Input: the checked tree. Output: the commit and its SHA in the journal.

## Stop conditions

Stop and go to P-L0-002 when:
- the scope check of step 4 fails a second time for the same change;
- a change you need lies on a forbidden or protected path that the frame does not name;
- `git status` shows another session's uncommitted work in the paths you must change;
- no owner word and no delegation that holds covers a commit, tag or push you need.

## Back edges

- `4>3/1/owner`: a failed scope check returns to the change once; a second failure goes to the owner.

## Execution map

Originally measured on base `4409f671` (S6-T02 author report section 3); scope/encoding rows and
source pointers refreshed for K2-CORE fix2 on 2026-10-14. Historical corpus counts are not current measurements.
TEXT-ONLY means no tool executes
the rule; each such row names its candidate gate (task ids of the L9 delta,  on
branch `ops-l9-audit-claude`). This record adds no enforcement.

| Rule | Executed by | State and gap |
|---|---|---|
| R-L9-001.1 | `.ai/bin/protocol-hooks.cjs:395-397` prints `git status` at session start | TEXT-ONLY: whether code was read is judgement; the print is a help, not a check |
| R-L9-001.2 | `.ai/bin/protocol-scope.cjs:45-155`, by hand | partial: out-of-scope paths are found, and the diff at `.ai/bin/protocol-scope.cjs:83` runs with `--no-renames`, so a rename shows both of its paths (before S6-T02 fix round 1 a forbidden file moved into scope passed, probe exit 0; test  N-1); incidental renames and reformatting are TEXT-ONLY; candidate scope-check (S6-T30) |
| R-L9-001.3 | none | TEXT-ONLY: no tool checks the branch; `docs/ops/ops-guard.cjs` launch-gate does not read it |
| R-L9-001.4 | `.ai/bin/protocol-scope.cjs:45-155`, by hand | partial: explicit PRE/POST calls use the shared reader at `.ai/bin/protocol-scope.cjs:55`; literals, terminal segment globs and recursive trees are checked through `.ai/bin/protocol-scope.cjs:34-42`; without `--forbidden`, own TASK declarations or standing defaults come from `.ai/bin/lib/scope-contract.cjs:66-114`, read by one reader that accepts every own-line Markdown form (plain, bullet, numbered, bold, indented) and refuses conflict, inline comment and an unparseable declaration instead of using defaults; explicit input files are read below the repository root only. Universal launcher wiring remains absent; candidates scope-check and masks (S6-T30, S6-T37) |
| R-L9-001.5 | `.ai/bin/protocol-verdict.cjs:67-118` (findings-ledger verdict only) | TEXT-ONLY elsewhere: other lists at `.ai/bin/protocol-scope.cjs:15-28`, `.ai/bin/validator/gate-structure.cjs:342-345`, `.ai/bin/protocol-handoff/gate.cjs:187-205`, `.ai/bin/validator/repository.cjs:173-186`, ; candidate one protected set (S6-T37, Class A) |
| R-L9-001.6 | `docs/ops/launch-wrapper.cjs:12-14` (P-25, WARN only); `.ai/docs/clients.json:336-338` (one client denies git commit, push, tag) | TEXT-ONLY as a rule: no git hook is installed and none checks a freeze commit against the scope; candidates pre-commit sample and scope-check of a commit (S6-T35, S6-T30) |
| R-L9-001.7 | `.ai/bin/validator/text.cjs:53-76` (CM-15..CM-19); `.ai/bin/validator/text.cjs:245-249` (CM-70 tracked-text domain); `.ai/bin/validator/text.cjs:344-427` (guarded tracked scan, role-scoped blocking scope and capped severity); `.ai/bin/validator/repository.cjs:193-200` (one decision for blocking-scanned files); `.gitattributes:3` | partial: CM-70 now covers all tracked text (an empty enumeration is a FAIL, or an explicit WARN when git itself listed nothing), with suffix plus signature for its explicit binary domain, strict UTF-8/BOM/NUL/LF and ASCII PowerShell failures on protocol-owned files, host files never failed in the installed role, and advisory decoder notes. Universal argv/output transport verification remains absent; the historical BOM was repaired by a three-byte removal in K2-CORE fix2 |

## Evidence

- B - git and code rules in seven places and five protected-path lists (L9 audit X-2, X-8; , C-01); CRLF breakage of 29 of 105 tests (L9 audit X-10). Cost: unknown in attempts.
- B - the rules being homed: `AGENTS.md:415-441` (section 9 and 10), `AGENTS.md:445-454` (section 11), DEC-0001, PROTO-DEC-0046 item 3; RULE-MAP rows `.ai/core/RULE-MAP.md:74-79`.
- C - the owner's design of  section 5 (). Trial: none defined yet; a class C record needs one before it can be active (R-L0-17.5).

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| The record is read as enforced | medium | high | the execution map marks every text-only rule | none | a reader who skips the map |
| Rename out of a forbidden path passes the scope check | medium | high | the tool diffs with `--no-renames` (it passed before, exit 0) | none | a frame that puts both paths in scope; nothing calls the tool until S6-T30 |
| Encoding defects outside the owned files | low | medium | `.gitattributes` normalises LF at commit | none | a BOM or a non-ASCII `.ps1` outside the owned set |
| Several protected sets keep diverging | high | medium | R-L9-001.5 names the one source | none | five lists until S6-T37 |

## Change log

- 0.1 — 2026-10-10
- 0.2 — 2026-10-10
- 0.3 — 2026-10-14
- 0.4 — 2026-10-14
- 0.5 — 2026-10-14
