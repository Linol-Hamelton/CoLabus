---
id: P-L3-002
version: 0.4
title: Discover providers, models and effort levels; build the candidate matrix and the tier table
layer: L3
type: procedure
status: active
owner_approval: PROTO-DEC-0159
decision: [PROTO-DEC-0159]
roles: [coordinator]
stages: [session, dispatch]
triggers: [install, upgrade, owner-directive]
inputs: [journal]
outputs: [journal]
back_edges: []
enforcement: P
script_candidate: yes
evidence_class: [B, C]
evidence: [PROTO-DEC-0047, PROTO-DEC-0058, PROTO-DEC-0059, PROTO-DEC-0146]
cost_basis: unknown
supersedes: []
---

# P-L3-002 Model discovery and the tier table

Model discovery reads client capabilities and produces tier-table data. Deterministic steps read CLI output; ranking model strength remains judgement unless supported by provider data. The metadata declares the current status and approval basis.

## Purpose

The P-L2-002 tier table must use models available in the host project and effort
levels the actual client offers. This procedure derives those entries from
provider information and verified client behavior.

## Rules

- R-L3-002.1. The tier table contains only models and effort levels obtained through steps 1-6;
  a cell not obtained that way is empty, never guessed.
- R-L3-002.2. Per provider, three model ranks are kept: flagship (strongest), second (next after
  the flagship), workhorse (best price to quality per token).
- R-L3-002.3. Per model, three effort levels are kept: minimum, middle and maximum, taken as the
  three levels nearest the centre of the model's ordered list of effort levels. With an even
  number of levels, the middle is the upper of the two central levels (a, b, c, d → b, c, d).
  With fewer than three levels, the available levels are repeated: one level fills all three
  slots; with two, the minimum is the lower and the middle and maximum are the upper; the matrix
  records that the provider has fewer than nine distinct tiers.
- R-L3-002.4. Three model ranks times three effort levels give nine tiers, T1 to T9, per provider,
  model rank first: workhorse T1-T3, second T4-T6, flagship T7-T9, each from minimum to maximum.
- R-L3-002.5. Every value records its source (the command and its output) and the date.

## Steps

1. **Providers** (coordinator). When CoLabus is installed or upgraded in a project, check through
   the command line which AI assistant clients are available (for example `claude --version`,
   `codex --version`, `agy --version`, `copilot --version`, `vibe --version`); record each answer.
2. **Models** (coordinator). For each available provider, obtain the list of available models from
   the provider itself (its help or model-list output); record the command and the list.
3. **Candidates** (coordinator). From each list pick the flagship, the second and the workhorse
   (R-L3-002.2). Record the reason for each pick and its source.
4. **Matrix** (coordinator). Write the candidate matrix: provider × {flagship, second, workhorse}.
5. **Effort levels** (coordinator). For each model in the matrix, obtain the effort levels it
   supports by querying the model or its client; record the ordered list.
6. **Three levels** (coordinator). Take the three levels nearest the centre of each ordered list as
   minimum, middle and maximum (R-L3-002.3), and fill the nine tiers (R-L3-002.4).

## Stop conditions

- A provider gives no model list or no effort list: its cells stay empty and the gap is a
  `procedure-gap` signal.
- The flagship, second or workhorse cannot be told apart from the provider's own information:
  go to P-L0-002 (the owner decides).

## Back edges

None.

## Evidence

Decision basis: PROTO-DEC-0058 and PROTO-DEC-0047 item 9. Provider model
lists and client effort flags require verified data. Trial: M-007.
No source-project tier assignments or availability measurements are supplied.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| A provider does not say which model is strongest | high | medium | stop to the owner; record the reason for each pick | owner attention | judgement for step 3 |
| Effort lists change with versions | high | medium | re-run on upgrade (trigger); date on every value | one run | between upgrades |
| A client exposes no effort at all | medium | low | one level fills all three effort slots (R-L3-002.3) | — | fewer distinct tiers, recorded in the matrix |

## Change log

- 0.1 — 2026-09-24
- 0.2 — 2026-09-24
- 0.3 — 2026-10-04
- 0.4 — 2026-10-04
