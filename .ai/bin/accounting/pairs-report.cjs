#!/usr/bin/env node
'use strict';
// pairs-report.cjs - the comparison report of the pairs recorder (PROTO-DEC-0143 item 3: the owner switches the selection layer to controlling mode only
// after reading a report that compares recommendations with real assignments and outcomes). Advisory, never Evidence. READ ONLY: it opens the pair
// journals (pairs/PAIRS-*.jsonl) and the epoch ledgers (pairs/EPOCHS-*.jsonl) and nothing else; it writes nothing.
//   node .ai/bin/accounting/pairs-report.cjs [--pairs DIR] [--lang ru|en] [--epoch ID] [--merge-epochs]
// Per epoch and task class: how often the recommendation equals the assignment, where they differ, the outcomes of the pairs that agree, differ and
// are undecided (verdict, exit code, mean cost and duration where known), the coverage (every field known), and an explicit list of what the data cannot
// yet support. A pair that does not pass the gate is counted and left out of the comparison. Epochs are never mixed unless --merge-epochs is given.
// The report NEVER prints a recommendation to switch: the owner decides. The output is deterministic (no clock, no path, sorted).
// Exit: 0 report printed; 2 usage.

const path = require('node:path');
const core = require('./lib/pairs-core.cjs');
const io = require('./lib/pairs-io.cjs');

const MIN_SAMPLE = 30; // a reporting threshold, not a decision: fewer comparable pairs than this is called small
const REPO = path.resolve(__dirname, '..', '..', '..');
const EVIDENCE_KEYS = ['ladderVersionSource', 'ladderMatchesCurrentFile', 'registryVersionSource', 'registryGeneratedAt'];
const FIELDS = [
  ['task-class', p => p.taskClass !== null], ['role', p => p.role !== null], ['recommendation-choice', p => Boolean(p.recommendation && p.recommendation.choice)],
  ['client', p => p.assignment.client !== null], ['model', p => p.assignment.model !== null], ['effort', p => p.assignment.effort !== null], ['route', p => p.assignment.route !== null],
  ['served-model', p => p.assignment.servedModel !== null], ['verdict', p => p.outcome.verdictExpected === false || (p.outcome.verdict !== null && p.outcome.verdict !== 'NO_VERDICT')],
  ['exit-code', p => p.outcome.exitCode !== null], ['duration', p => p.outcome.durationSeconds !== null], ['tokens', p => p.outcome.tokens !== null && p.outcome.tokens.total !== null],
  ['cost', p => Boolean(p.outcome.cost && (p.outcome.cost.basis === 'priced' || p.outcome.cost.basis === 'subscription'))],
];

const TEXT = {
  en: {
    title: 'PAIRS REPORT (advisory, never Evidence; read only)', epoch: 'EPOCH', agreement: 'agreement', cannot: 'CANNOT YET SUPPORT', all: 'ALL EPOCHS (mixed)', taskClass: 'task class',
    legend: 'legend: match = the recommended client and model equal the assigned ones; differ = recommended -> assigned; only pairs that pass the gate are compared',
    mixed: n => `EPOCHS MIXED BY REQUEST: ${n} epochs pooled; a change of the ladder or of the class registry inside the pool is not separated`,
    never: 'epochs are never mixed unless --merge-epochs is given',
    none: 'no pair records', noCompare: 'no comparison possible: no clean pair has both a recommendation choice and an assignment',
    small: (n, e, c) => `small sample: ${n} comparable pairs in ${e}, task class ${c} (fewer than ${MIN_SAMPLE}): no rate is reliable`,
    noneIn: (e, c) => `no comparable pair in ${e}, task class ${c}: the recommendation named no choice there`,
    verdictNone: (e, x) => `verdict: no pair of ${e} expected a verdict carries a verdict token; a verdict rate cannot be computed (${x})`,
    verdictLow: (m, e, x) => `verdict: only ${m} of ${e} pairs that expected a verdict carry a token (${x})`,
    thin: (k, n, x) => `thin: tokens or cost are unknown for ${k} of ${n} pairs (${x})`,
    notObserved: 'the outcome of a recommendation that was not assigned is never observed: outcomes are compared between pairs that agree, differ and are undecided, not between two routes on the same task',
    quarantined: 'a pair that does not pass the gate is not compared (see the quarantine lines)',
    owner: 'NO SWITCH RECOMMENDATION: the owner decides (PROTO-DEC-0143 item 3).',
  },
  ru: {
    title: 'ОТЧЁТ ПО ПАРАМ (совещательный, не Evidence; только чтение)', epoch: 'ЭПОХА', agreement: 'совпадение', cannot: 'ЧЕГО ДАННЫЕ ПОКА НЕ ПОДТВЕРЖДАЮТ', all: 'ВСЕ ЭПОХИ (смешаны)', taskClass: 'класс задачи',
    legend: 'легенда: match = рекомендованные клиент и модель равны назначенным; differ = рекомендовано -> назначено; сравниваются только пары, прошедшие ворота',
    mixed: n => `ЭПОХИ СМЕШАНЫ ПО ЗАПРОСУ: объединено эпох ${n}; смена лестницы или реестра классов внутри пула не разделена`,
    never: 'эпохи не смешиваются без --merge-epochs',
    none: 'записей пар нет', noCompare: 'сравнение невозможно: нет чистой пары, где есть и выбор рекомендации, и назначение',
    small: (n, e, c) => `малая выборка: ${n} сравнимых пар, ${e}, класс ${c} (меньше ${MIN_SAMPLE}): ни одна доля не надёжна`,
    noneIn: (e, c) => `нет сравнимых пар: ${e}, класс ${c}: рекомендация не назвала выбор`,
    verdictNone: (e, x) => `вердикт: ни у одной из ${e} пар, ожидавших вердикт, нет токена вердикта; доля вердиктов не считается (${x})`,
    verdictLow: (m, e, x) => `вердикт: токен есть только у ${m} из ${e} пар, ожидавших вердикт (${x})`,
    thin: (k, n, x) => `тонко: токены или стоимость неизвестны у ${k} из ${n} пар (${x})`,
    notObserved: 'исход рекомендации, которая не была назначена, не наблюдается никогда: сравниваются исходы пар, где рекомендация совпала, разошлась и не определена, а не два маршрута на одной задаче',
    quarantined: 'пара, не прошедшая ворота, не сравнивается (см. строки quarantine)',
    owner: 'РЕКОМЕНДАЦИИ О ПЕРЕКЛЮЧЕНИИ НЕТ: решает владелец (PROTO-DEC-0143 п.3).',
  },
};

const pct = (k, n) => (n ? `${(100 * k / n).toFixed(1)}%` : 'n/a');
const mean = (xs, digits) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(digits) : null);
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
const classRank = c => (c === 'unknown' ? 99 : Number(c.slice(1)));
const route = r => `${core.outText(r.client || '?')}:${core.outText(r.model || '?')}`;

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--merge-epochs') o.merge = true;
    else if (['--pairs', '--lang', '--epoch'].includes(a)) { if (i + 1 >= argv.length) return { error: `${a} needs a value` }; o[a.slice(2)] = argv[++i]; }
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

/**
 * Read the folder: valid, deduplicated pairs with their recomputed gate, and the counts of what was left out. EVERY record that is read is validated
 * (schema, real dates, the epoch against its own fields, privacy scan, advice scan): a pair line or an epoch ledger line that fails is counted and never
 * used and never printed, so nothing that reaches the output is an unvalidated field.
 */
function load(pairsDir) {
  const raw = io.readPairFiles(pairsDir);
  const seen = new Set(); const pairs = []; let invalid = raw.invalid; let duplicates = 0; let invalidEpochs = 0;
  for (const { rec } of raw.pairs.slice().sort((a, b) => a.file.localeCompare(b.file))) {
    if (core.validatePair(rec).length) { invalid++; continue; }
    if (seen.has(rec.launchId)) { duplicates++; continue; }
    seen.add(rec.launchId);
    pairs.push({ ...rec, gate: core.gateOf(rec) });
  }
  pairs.sort((a, b) => a.launchId.localeCompare(b.launchId));
  const ledger = new Map();
  const goodEpochs = [];
  for (const e of raw.epochLines) { if (core.validateEpoch(e).length) invalidEpochs++; else goodEpochs.push(e); }
  for (const e of goodEpochs.sort((a, b) => a.epochId.localeCompare(b.epochId))) if (!ledger.has(e.epochId)) ledger.set(e.epochId, e);
  return { pairs, ledger, files: raw.files, invalid, duplicates, invalidEpochs };
}

function outcomeLine(label, group) {
  const exp = group.filter(p => p.outcome.verdictExpected === true);
  const tokens = exp.filter(p => ['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED'].includes(p.outcome.verdict));
  const pass = tokens.filter(p => p.outcome.verdict === 'PASS').length;
  const exits = group.filter(p => p.outcome.exitCode !== null);
  const costs = group.filter(p => p.outcome.cost && p.outcome.cost.basis === 'priced' && typeof p.outcome.cost.usd === 'number').map(p => p.outcome.cost.usd);
  const durs = group.filter(p => p.outcome.durationSeconds !== null).map(p => p.outcome.durationSeconds);
  const cost = costs.length ? `${mean(costs, 4)} USD` : 'unknown';
  const dur = durs.length ? `${mean(durs, 1)} s` : 'unknown';
  return `outcome ${label}: n=${group.length} verdict PASS=${tokens.length ? `${pass} of ${tokens.length}` : 'n/a'} with a token (${tokens.length} of ${exp.length} expected) exit-ok=${exits.filter(p => p.outcome.exitCode === 0).length}/${exits.length} mean cost=${cost} (known ${costs.length} of ${group.length}) mean duration=${dur} (known ${durs.length} of ${group.length})`;
}

/** Sections of one epoch (or of the whole pool): header counts, per class comparison, coverage. Returns the lines and the facts the closing list needs. */
function describe(heading, pairs, T, facts) {
  const out = [];
  const clean = pairs.filter(p => p.gate.gate === 'clean');
  const codes = {};
  for (const p of pairs) for (const c of p.gate.codes) bump(codes, c);
  out.push(`pairs=${pairs.length} clean=${clean.length} quarantined=${pairs.length - clean.length}`);
  const codeText = core.CODES.filter(c => codes[c]).map(c => `${c}=${codes[c]}`).join(' ');
  if (codeText) out.push(`quarantine: ${codeText}`);
  const classes = [...new Set(clean.map(p => p.taskClass || 'unknown'))].sort((a, b) => classRank(a) - classRank(b));
  for (const c of classes) {
    const g = clean.filter(p => (p.taskClass || 'unknown') === c);
    const choice = g.filter(p => p.recommendation && p.recommendation.choice);
    const empty = g.filter(p => !(p.recommendation && p.recommendation.choice));
    const yes = g.filter(p => p.match === 'yes'); const no = g.filter(p => p.match === 'no'); const unk = g.filter(p => p.match === 'unknown');
    out.push(`-- ${T.taskClass} ${c} --`);
    out.push(`recommendation: present=${g.length} choice known=${choice.length} empty=${empty.length}`);
    if (empty.length) {
      const why = {}; for (const p of empty) bump(why, p.recommendation.error || p.recommendation.reason || p.recommendation.terminal || 'unknown');
      out.push(`empty reasons: ${Object.keys(why).sort().map(k => `${k}=${why[k]}`).join(' ')}`);
    }
    out.push(`match: yes=${yes.length} no=${no.length} unknown=${unk.length}`);
    const comparable = yes.length + no.length;
    out.push(comparable ? `${T.agreement}: ${pct(yes.length, comparable)} of ${comparable} comparable pairs` : `${T.agreement}: n/a (no comparable pair)`);
    const diffs = {}; for (const p of no) bump(diffs, `${route(p.recommendation.choice)} -> ${route(p.assignment)}`);
    for (const k of Object.keys(diffs).sort((a, b) => diffs[b] - diffs[a] || a.localeCompare(b)).slice(0, 10)) out.push(`differ: ${k} x${diffs[k]}`);
    for (const [label, grp] of [['agree', yes], ['differ', no], ['undecided', unk]]) if (grp.length) out.push(outcomeLine(label, grp));
    facts.comparable.push({ heading, cls: c, n: comparable, clean: g.length });
    facts.total += comparable;
  }
  if (clean.length) {
    const full = clean.filter(p => FIELDS.every(([, f]) => f(p))).length;
    out.push(`coverage: ${pct(full, clean.length)} (${full} of ${clean.length} clean pairs have every field known)`);
    out.push(`field coverage: ${FIELDS.map(([name, f]) => `${name}=${pct(clean.filter(f).length, clean.length)}`).join(' ')}`);
    const exp = clean.filter(p => p.outcome.verdictExpected === true);
    const withToken = exp.filter(p => ['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED'].includes(p.outcome.verdict)).length;
    if (exp.length) facts.verdict.push({ heading, exp: exp.length, withToken });
    const thin = clean.filter(p => !p.outcome.tokens || p.outcome.tokens.total === null || !(p.outcome.cost && (p.outcome.cost.basis === 'priced' || p.outcome.cost.basis === 'subscription'))).length;
    facts.thin.push({ heading, k: thin, n: clean.length });
  }
  return out;
}

function report(data, o, T) {
  const lines = [T.title, `pair files: ${data.files}; pair lines valid=${data.pairs.length}; invalid lines=${data.invalid}; duplicate launches=${data.duplicates}; invalid epoch lines=${data.invalidEpochs}`, T.legend];
  const facts = { comparable: [], total: 0, verdict: [], thin: [] };
  const byEpoch = new Map();
  for (const p of data.pairs) { if (!byEpoch.has(p.epoch.id)) byEpoch.set(p.epoch.id, []); byEpoch.get(p.epoch.id).push(p); }
  const startOf = ps => ps.map(p => p.startedAt).filter(Boolean).sort()[0] || '9999';
  let ids = [...byEpoch.keys()].sort((a, b) => startOf(byEpoch.get(a)).localeCompare(startOf(byEpoch.get(b))) || a.localeCompare(b));
  if (o.epoch) ids = ids.filter(id => id === o.epoch);
  lines.push(`epochs: ${ids.length} (${T.never})`);
  if (!data.pairs.length) lines.push(T.none);
  else if (o.merge) {
    lines.push(T.mixed(ids.length), `== ${T.all} ==`);
    lines.push(...describe(T.all, ids.flatMap(id => byEpoch.get(id)), T, facts));
  } else {
    for (const id of ids) {
      const ps = byEpoch.get(id); const e = ps[0].epoch; const led = data.ledger.get(id);
      const times = ps.map(p => p.startedAt).filter(Boolean).sort();
      const st = e.selectorTuple; const selector = st.client || st.model || st.effort || e.selectorPromptSha256
        ? `${st.client || '?'}:${st.model || '?'} effort=${st.effort || '?'} prompt=${e.selectorPromptSha256 ? e.selectorPromptSha256.slice(0, 12) : '?'}` : 'unknown';
      lines.push(`== ${T.epoch} ${id} ==`, `ladder: ${e.ladderVersion || 'unknown'}`, `class registry: ${e.classRegistryVersion || 'unknown'}`, `selector: ${selector}`, `first launch: ${times[0] || 'unknown'}; last launch: ${times[times.length - 1] || 'unknown'}`);
      const ev = led && led.evidence ? EVIDENCE_KEYS.filter(k => led.evidence[k] !== undefined && led.evidence[k] !== null).map(k => `${k}=${led.evidence[k]}`) : [];
      lines.push(ev.length ? `evidence: ${ev.join(' ')}` : 'evidence: none recorded');
      lines.push(...describe(`${T.epoch.toLowerCase()} ${id}`, ps, T, facts));
    }
  }
  lines.push(`${T.cannot}:`);
  if (data.pairs.length && facts.total === 0) lines.push(`- ${T.noCompare}`);
  for (const f of facts.comparable) {
    if (f.n > 0 && f.n < MIN_SAMPLE) lines.push(`- ${T.small(f.n, f.heading, f.cls)}`);
    else if (f.n === 0) lines.push(`- ${T.noneIn(f.heading, f.cls)}`);
  }
  for (const v of facts.verdict) {
    if (v.withToken === 0) lines.push(`- ${T.verdictNone(v.exp, v.heading)}`);
    else if (v.withToken * 2 < v.exp) lines.push(`- ${T.verdictLow(v.withToken, v.exp, v.heading)}`);
  }
  for (const t of facts.thin) if (t.k * 2 > t.n) lines.push(`- ${T.thin(t.k, t.n, t.heading)}`);
  lines.push(`- ${T.notObserved}`, `- ${T.quarantined}`, T.owner);
  return lines;
}

function main(argv, deps = {}) {
  const say = s => (deps.stdout || process.stdout).write(`${s}\n`);
  const o = parseArgs(argv);
  if (o.error) { say(`ERROR ${o.error}\nusage: pairs-report.cjs [--pairs DIR] [--lang ru|en] [--epoch ID] [--merge-epochs]`); return 2; }
  const lang = o.lang || 'ru';
  if (!TEXT[lang]) { say(`ERROR --lang must be ru or en`); return 2; }
  const dir = path.resolve(o.pairs || io.defaultPairsDir(REPO));
  const data = load(dir);
  if (o.epoch && !data.pairs.some(p => p.epoch.id === o.epoch)) { say(`ERROR no pair of epoch ${o.epoch} in ${path.basename(dir)}`); return 2; }
  say(report(data, o, TEXT[lang]).join('\n'));
  return 0;
}

module.exports = { main, load, report, parseArgs, MIN_SAMPLE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
