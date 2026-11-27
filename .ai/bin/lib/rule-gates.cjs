'use strict';
// Rule gates: the one runner of the kernel's fact gates (precert, identity, review, task-file).
// Scheme: a gate refuses only on exact facts (a file exists or not, a hash matches or not); a fact that
// needs judgement is a warning. Every run is measured against its time budget and appended to the audit
// ledger <runtime>/rule-gates/audit.jsonl, one JSON object per line, never rewritten. A conscious override
// (a written reason) lets the work go on and is recorded in the same ledger; a gate listed in
// ruleGates.demoted reports its failed facts as warnings. Configuration is the "ruleGates" object of
// protocol-manifest.json of the repository that runs the gate (never of the candidate it checks):
//   { "budgetSeconds": { "default": 60, "precert": 60 }, "demoted": ["review"],
//     "identity": { "allowed": [{ "name": "N", "email": "E" }], "placeholderNames": ["Cert Probe"] },
//     "precert": { "derived": [{ "name": "core-catalog", "path": ".ai/core/CATALOG.md", "command": ["node", "..."] }] } }
// The seat ledger <runtime>/seat-ledger.jsonl (append-only) records every launch attempt of the launch wrapper.
// The precert gate is overridden fact by fact: an override names exact fact codes, each with its own reason, and every
// refused fact it does not name still refuses. A standing waiver is configuration, never a command-line reason:
// ruleGates.precert.waivers [{ "decision": "PROTO-DEC-nnnn item n", "facts": ["CODE"], "reason": "..." }]. The single
// whole-gate reason of the older form still works for the facts a whole-gate reason may cover; it never covers a fact
// of NEVER_WAIVED (no override of any form does), nor a citation or pin fact (CITE_FACT), which only an override
// naming its code lifts. A fact that carries waiveWord is lifted only by a reason that contains that word.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BUDGET_SECONDS = 60;
const GATES = ['precert', 'identity', 'review', 'task-file'];
const OVERRIDE_MIN = 12;
// Facts that no override, waiver or whole-gate reason lifts: the identity of the candidate and of the seat, the
// producer Evidence, a dirty tree, test enrollment, the audit prompt named as the protocol file, a broken gate and the
// override and waiver forms themselves.
const NEVER_WAIVED = Object.freeze(['P-HEAD', 'P-CANDIDATE', 'P-SEAT-JOURNAL', 'P-JOURNAL', 'P-CLEAN', 'P-ENROLLED',
  'P-AUDIT-PROMPT-AGENTS', 'GATE_ERROR', 'OVERRIDE_REASON_INVALID', 'OVERRIDE_FORM_INVALID', 'WAIVER_CONFIG_INVALID', 'AUDIT_NOT_RECORDED']);
// Citation and pin facts: a standing waiver never lists them and a whole-gate reason never covers them.
const CITE_FACT = /^(?:P-CITES|P-DERIVED(?::.+)?|P-CORPUS|P-SPEC-CITES|P-CITE-CONSUMERS)$/;
const FACT_CODE = /^[A-Z][A-Z0-9_-]*(?::[A-Za-z0-9._-]+)?$/;
const AUDIT_FILE = path.join('rule-gates', 'audit.jsonl');
const SEAT_FILE = 'seat-ledger.jsonl';
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function readManifest(root) {
  try { const m = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')); return plain(m) ? m : null; }
  catch { return null; }
}
function config(root) {
  const m = readManifest(root);
  return m && plain(m.ruleGates) ? m.ruleGates : {};
}
function budgetSeconds(cfg, gate) {
  const b = plain(cfg.budgetSeconds) ? cfg.budgetSeconds : {};
  const v = Object.hasOwn(b, gate) ? b[gate] : b.default;
  return Number.isFinite(v) && v > 0 && v <= 3600 ? v : DEFAULT_BUDGET_SECONDS;
}
const isDemoted = (cfg, gate) => Array.isArray(cfg.demoted) && cfg.demoted.includes(gate);
// An override reason is a sentence a person wrote: at least 12 visible characters, no control character.
function overrideProblem(reason) {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string' || reason.trim().length < OVERRIDE_MIN || /[\u0000-\u001f\u007f]/.test(reason)) return 'OVERRIDE_REASON_INVALID';
  return null;
}
const reasonProblem = reason => (typeof reason !== 'string' ? 'OVERRIDE_REASON_INVALID' : overrideProblem(reason));
// The standing waivers of the precert gate. -> { rows: [{ decision, facts, reason }], problem }
function waivers(cfg) {
  const list = plain(cfg.precert) && Object.hasOwn(cfg.precert, 'waivers') ? cfg.precert.waivers : [];
  if (!Array.isArray(list)) return { rows: [], problem: 'ruleGates.precert.waivers is not a list' };
  for (const w of list) {
    if (!plain(w) || typeof w.decision !== 'string' || !/^(?:PROTO-)?DEC-\d{4}(?: item \d+)?$/.test(w.decision) || !Array.isArray(w.facts)
      || !w.facts.length || reasonProblem(w.reason)) return { rows: [], problem: 'a waiver row needs a decision id, a list of fact codes and a one-line reason' };
    for (const code of w.facts) {
      if (typeof code !== 'string' || !FACT_CODE.test(code)) return { rows: [], problem: `the waiver of ${w.decision} names a malformed fact code` };
      if (NEVER_WAIVED.includes(code) || CITE_FACT.test(code)) return { rows: [], problem: `the waiver of ${w.decision} lists ${code}, which no standing waiver may cover` };
    }
  }
  return { rows: list, problem: null };
}
// The fact overrides of one precert run: [{ code, reason }], one per exact code. -> { rows, problem }
function factOverrides(list) {
  if (list === undefined || list === null) return { rows: [], problem: null };
  if (!Array.isArray(list)) return { rows: [], problem: 'the fact overrides are not a list' };
  const seen = new Set();
  for (const o of list) {
    if (!plain(o) || typeof o.code !== 'string' || !FACT_CODE.test(o.code)) return { rows: [], problem: 'a fact override needs one exact fact code (no wildcard, no prefix)' };
    if (reasonProblem(o.reason)) return { rows: [], problem: `the reason of the override of ${o.code} must be at least ${OVERRIDE_MIN} visible characters on one line` };
    if (seen.has(o.code)) return { rows: [], problem: `${o.code} is overridden twice` };
    seen.add(o.code);
  }
  return { rows: list, problem: null };
}
// What lifts one refused precert fact: { by, reason, decision? } or null (it still refuses).
function liftOf(fact, named, standing, legacy) {
  if (NEVER_WAIVED.includes(fact.code)) return null;
  const fits = reason => !fact.waiveWord || (typeof reason === 'string' && reason.includes(fact.waiveWord));
  const own = named.find(o => o.code === fact.code);
  if (own) return fits(own.reason) ? { by: 'override', reason: own.reason } : null;
  const waiver = standing.find(w => w.facts.includes(fact.code) && fits(w.reason));
  if (waiver) return { by: 'waiver', decision: waiver.decision, reason: waiver.reason };
  if (typeof legacy === 'string' && !CITE_FACT.test(fact.code) && fits(legacy)) return { by: 'legacy', reason: legacy };
  return null;
}
// The waived facts of one ledger row, for both row forms: a row of the older form carries one reason that covered every
// failed fact; a newer row lists each waived fact.
function rowWaivers(row) {
  if (!plain(row)) return [];
  if (Array.isArray(row.waived)) return row.waived.filter(w => plain(w) && typeof w.code === 'string');
  if (row.outcome === 'override' && typeof row.reason === 'string' && Array.isArray(row.failed)) return row.failed.map(code => ({ code, by: 'legacy', reason: row.reason }));
  return [];
}
// One line appended to a JSONL ledger. Returns null or the error code; it never throws.
function appendLine(file, event) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`, 'utf8');
    return null;
  } catch (e) { return String((e && e.code) || 'WRITE_FAILED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'WRITE_FAILED'; }
}
const auditFile = runtime => path.join(runtime, AUDIT_FILE);
const seatFile = runtime => path.join(runtime, SEAT_FILE);
const oneLine = s => String(s === undefined || s === null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, 400);

// Runs one gate. evaluate() returns facts [{ code, ok, level: 'gate'|'warn', detail, fix, waiveWord? }].
// override is the whole-gate reason; overrides ([{ code, reason }]) are the fact overrides of the precert gate.
// -> { gate, outcome: pass|refuse|warn|override, ok, refused, open, waived, warnings, ms, budgetMs, overBudget, demoted, lines, ledgerError }
// refused lists every refused fact, open the ones no override, waiver or reason lifted.
function runGate({ gate, root, runtime, subject = null, override, overrides, evaluate, clock = () => Date.now(), now = () => new Date() }) {
  if (!GATES.includes(gate)) throw new Error(`unknown gate ${gate}`);
  const cfg = config(root);
  const precert = gate === 'precert';
  const budgetMs = budgetSeconds(cfg, gate) * 1000;
  const demoted = isDemoted(cfg, gate);
  const started = clock();
  let facts;
  const bad = overrideProblem(override);
  const named = precert ? factOverrides(overrides) : { rows: [], problem: overrides === undefined ? null : 'fact overrides exist for the precert gate only' };
  const formProblem = named.problem || (named.rows.length && typeof override === 'string' ? 'a whole-gate reason and fact overrides were given together' : null);
  const standing = precert ? waivers(cfg) : { rows: [], problem: null };
  if (bad) facts = [{ code: bad, ok: false, level: 'gate', detail: `the override reason must be at least ${OVERRIDE_MIN} visible characters on one line`, fix: 'write why the gate is overridden, in one sentence' }];
  else if (formProblem) facts = [{ code: 'OVERRIDE_FORM_INVALID', ok: false, level: 'gate', detail: formProblem, fix: 'name each refused fact once with its own reason (CODE=REASON), without a whole-gate reason beside them' }];
  else {
    try { facts = evaluate(); } catch (e) { facts = [{ code: 'GATE_ERROR', ok: false, level: 'gate', detail: oneLine(e && e.message), fix: precert ? 'repair the cause; no override lifts a gate error' : 'repair the cause, or override with a written reason' }]; }
    if (standing.problem) facts = [...facts, { code: 'WAIVER_CONFIG_INVALID', ok: false, level: 'gate', detail: standing.problem, fix: 'repair ruleGates.precert.waivers in protocol-manifest.json of the launching repository' }];
  }
  const ms = Math.max(0, clock() - started);
  const failed = facts.filter(f => !f.ok);
  let refused = failed.filter(f => f.level !== 'warn');
  let warnings = failed.filter(f => f.level === 'warn');
  if (demoted && !bad && !formProblem) { warnings = [...warnings, ...refused]; refused = []; }
  const waived = []; let open = refused;
  if (precert && !bad && !formProblem) {
    open = [];
    for (const f of refused) { const lift = liftOf(f, named.rows, standing.rows, override); if (lift) waived.push({ fact: f, ...lift }); else open.push(f); }
  } else if (!precert && refused.length && typeof override === 'string' && !bad) { open = []; for (const f of refused) waived.push({ fact: f, by: 'legacy', reason: override }); }
  let outcome = open.length ? 'refuse' : waived.length ? 'override' : (warnings.length ? 'warn' : 'pass');
  const overBudget = ms > budgetMs;
  const legacyUsed = waived.some(w => w.by === 'legacy');
  const event = { schema: 'rule-gate-event/1', time: now().toISOString(), gate, outcome, subject, failed: refused.map(f => f.code), warnings: warnings.map(f => f.code), ms, budgetMs, overBudget, demoted,
    ...(legacyUsed ? { reason: oneLine(override) } : {}),
    ...(precert && waived.length ? { waived: waived.map(w => ({ code: w.fact.code, by: w.by, ...(w.decision ? { decision: w.decision } : {}), reason: oneLine(w.reason) })), open: open.map(f => f.code) } : {}) };
  const ledgerError = runtime ? appendLine(auditFile(runtime), event) : 'NO_RUNTIME';
  // A precert override that the ledger did not record is not an override: it refuses.
  if (precert && waived.length && ledgerError) {
    open = [...open, { code: 'AUDIT_NOT_RECORDED', ok: false, level: 'gate', detail: `the audit ledger did not record the override (${ledgerError})`, fix: 'repair the runtime directory of the audit ledger, then run the gate again' }];
    outcome = 'refuse';
  }
  const lines = [`RULE-GATE gate=${gate} outcome=${outcome} ms=${ms} budget=${budgetMs}${demoted ? ' demoted=yes' : ''}`];
  const said = f => `${f.code}: ${oneLine(f.detail)}${f.fix ? `; fix: ${oneLine(f.fix)}` : ''}`;
  for (const w of waived) lines.push(`OVERRIDDEN ${said(w.fact)}`);
  for (const f of open) lines.push(`REFUSED ${said(f)}`);
  for (const f of warnings) lines.push(`WARN ${said(f)}`);
  if (legacyUsed) lines.push(`OVERRIDE gate=${gate} reason="${oneLine(override)}" (recorded in the audit ledger)`);
  for (const w of waived.filter(x => x.by !== 'legacy')) lines.push(`OVERRIDE gate=${gate} fact=${w.fact.code} by=${w.by}${w.decision ? ` decision="${w.decision}"` : ''} reason="${oneLine(w.reason)}" (recorded in the audit ledger)`);
  if (precert && (typeof override === 'string' || named.rows.length)) {
    for (const f of open.filter(x => refused.includes(x))) {
      lines.push(`OVERRIDE-NOT-APPLIED ${f.code}: ${NEVER_WAIVED.includes(f.code) ? 'no override lifts this fact' : f.waiveWord ? `the reason must contain ${f.waiveWord}` : 'name it with its own override CODE=REASON'}`);
    }
    for (const o of named.rows.filter(r => !refused.some(f => f.code === r.code))) lines.push(`OVERRIDE-UNUSED ${o.code}: the fact did not refuse`);
  }
  if (overBudget) lines.push(`OVER-BUDGET gate=${gate} ms=${ms} budget=${budgetMs}; when this repeats, demote the gate in protocol-manifest.json ruleGates.demoted`);
  if (ledgerError) lines.push(`AUDIT-NOT-RECORDED gate=${gate} code=${ledgerError}`);
  return { gate, outcome, ok: outcome !== 'refuse', refused, open, waived: waived.map(w => ({ code: w.fact.code, by: w.by, ...(w.decision ? { decision: w.decision } : {}), reason: w.reason })), warnings, ms, budgetMs, overBudget, demoted, lines, ledgerError };
}

// One launch attempt of the launch wrapper. Fields: name, stream, client, model, route, outcome, refusalClass, exitCode.
function recordSeat(runtime, entry, now = () => new Date()) {
  return appendLine(seatFile(runtime), { schema: 'seat-ledger/1', time: now().toISOString(), ...entry });
}

function readJsonl(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return { rows: [], unreadable: 0, missing: e.code === 'ENOENT' }; }
  const rows = []; let unreadable = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const j = JSON.parse(line); if (plain(j)) rows.push(j); else unreadable++; } catch { unreadable++; }
  }
  return { rows, unreadable, missing: false };
}
// Counters of one UTC day (YYYY-MM-DD): per gate the outcomes, over-budget runs and gate time; per seat outcome and refusal class.
function counters(runtime, day) {
  const audit = readJsonl(auditFile(runtime));
  const seats = readJsonl(seatFile(runtime));
  const gates = {}; let gateMs = 0; const waivedFacts = {};
  for (const e of audit.rows) {
    if (typeof e.time !== 'string' || !e.time.startsWith(day) || typeof e.gate !== 'string') continue;
    const g = gates[e.gate] || (gates[e.gate] = { pass: 0, refuse: 0, warn: 0, override: 0, overBudget: 0, ms: 0 });
    if (['pass', 'refuse', 'warn', 'override'].includes(e.outcome)) g[e.outcome]++;
    if (e.overBudget === true) g.overBudget++;
    if (Number.isFinite(e.ms)) { g.ms += e.ms; gateMs += e.ms; }
    for (const w of rowWaivers(e)) { const key = `${e.gate}:${w.code}`; waivedFacts[key] = (waivedFacts[key] || 0) + 1; }
  }
  const launches = { total: 0, outcomes: {}, refusals: {} };
  for (const s of seats.rows) {
    if (typeof s.time !== 'string' || !s.time.startsWith(day)) continue;
    launches.total++;
    const o = typeof s.outcome === 'string' ? s.outcome : 'unknown';
    launches.outcomes[o] = (launches.outcomes[o] || 0) + 1;
    if (s.refusalClass) launches.refusals[s.refusalClass] = (launches.refusals[s.refusalClass] || 0) + 1;
  }
  return { day, gates, gateMs, launches, waivedFacts, unreadable: audit.unreadable + seats.unreadable };
}
function statusLines(c) {
  const out = [`RULE-GATES day=${c.day} gate-time-ms=${c.gateMs}${c.unreadable ? ` unreadable-lines=${c.unreadable}` : ''}`];
  const names = Object.keys(c.gates).sort();
  if (!names.length) out.push('gates: no gate ran this day');
  for (const n of names) { const g = c.gates[n]; out.push(`gate ${n}: pass=${g.pass} refuse=${g.refuse} warn=${g.warn} override=${g.override} over-budget=${g.overBudget} ms=${g.ms}`); }
  const fmt = o => Object.keys(o).sort().map(k => `${k}=${o[k]}`).join(' ') || '-';
  if (c.waivedFacts && Object.keys(c.waivedFacts).length) out.push(`waived facts: ${fmt(c.waivedFacts)}`);
  out.push(`launches: total=${c.launches.total} ${fmt(c.launches.outcomes)}; refusals ${fmt(c.launches.refusals)}`);
  return out;
}

module.exports = { DEFAULT_BUDGET_SECONDS, GATES, OVERRIDE_MIN, NEVER_WAIVED, CITE_FACT, config, budgetSeconds, isDemoted, overrideProblem, waivers, factOverrides, liftOf, rowWaivers, runGate, recordSeat, counters, statusLines, auditFile, seatFile, readManifest };
