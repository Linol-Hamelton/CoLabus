---
id: M-008
version: 0.4
title: Signals per package by type and time until a signal group closes
layer: L6
type: metric
status: active
owner_approval: PROTO-DEC-0192
decision: [PROTO-DEC-0192]
roles: [coordinator, procedure-author]
stages: [triage, close]
triggers: [signal:procedure-gap, signal:script-candidate]
inputs: [signals, journal]
outputs: [journal]
back_edges: []
enforcement: S
enforced_by: [docs/ops/metrics/M-008.cjs]
script_candidate: yes
evidence_class: [C]
evidence: [docs/ops/metrics/M-008.cjs:2, .ai/core/L0-meta/P-L0-006-retire-or-improve-candidates.md:81, PROTO-DEC-0051:2]
---

# M-008 Signals per package

Draft of the unified-completion record set (PROTO-DEC-0185 item 2); binding only by a later
owner act. The trial of P-L0-006 names this metric.

## Purpose

Signals are the fleet's own record of friction: a procedure gap, a script candidate, a
fall. Which signal types repeat, and how long a root-cause group stays open, decides what
the procedural work does next. Without this count, the loudest package wins attention
instead of the widest root cause.

## Rules

- R-L6-M008.1. The metric counts signals per package by type over the signals ledger ( section 6, row M-008); the time from a signal to the closing of its root-cause group needs a close date per signal, which the ledger does not carry today (it stores an open date and a closed state), so `docs/ops/metrics/M-008.cjs` reports the time-to-close as null - a pending obligation, never a zero. [not mechanically enforced]
- R-L6-M008.2. Строка Signal вне закрытой грамматики даёт exit 2; value — доля строк closed среди всех строк (пустой журнал: null). meanDaysToClose=null, поскольку даты закрытия нет; отдельные времена групп скрипт не выводит. [test:  :: M-008 closed share computed from the closed grammar; unparsed rows refuse]
- R-L6-M008.3. Unknown is never a number: a package without recorded signals is not a zero-signal package when its ledger slice is unreadable; day granularity is the limit of the time measure and is stated, not smoothed. [not mechanically enforced]
- R-L6-M008.4. The output is advisory: never Evidence, never a gate input; the escalation rule (a group open two packages in a row goes to the owner) is PROTO-DEC-0051 item 2 and stays the acting rule, not a threshold of this record. [not mechanically enforced]
- R-L6-M008.5. Freshness: recomputed at each batch planning run of the signals tool; counts from before the last plan are not read as current. [not mechanically enforced]

## Steps

1. **Run** (coordinator). `node docs/ops/metrics/M-008.cjs [--a FILE] [--b FILE]`; the defaults are the two comparable date slices of the ledger. Input: the signals ledger. Output: counts by type and time-to-close, exit 0 with nulls allowed, exit 2 on an unreadable row.
2. **Read** (coordinator). The counts order the procedural work: which root-cause group closes first. Input: the table. Output: the plan line in the journal.

## Stop conditions

Stop and go to P-L0-002 when the ledger holds an unparseable row; the metric stops at the named row and never proceeds on a partial read.

## Back edges

None.

## Evidence

- C - the design is  section 6 row M-008; the consumer is the procedural work priority and the grouping of PROTO-DEC-0051 item 2.
- C - the leaf script exists (docs/ops/metrics/M-008.cjs) with the closed ledger-row grammar.

## Risks

| Risk | Likelihood | Impact | Coverage | Cost | Residual |
|---|---|---|---|---|---|
| An unparseable row is skipped | low | high | R-L6-M008.2 makes it exit 2 | none | none |
| Participants stop writing signals | medium | medium | one command; journal lines allowed at planning import | none | an empty ledger reads as calm |

## Change log

- 0.1 — 2026-10-14
- 0.2 — 2026-10-15

- 0.3 — 2026-10-15
- 0.4 — 2026-10-16
