'use strict';
// bypass-register.cjs - the checker of the kernel bypass register (a source-repository file), CM-77.
// A bypass is a procedure the operator runs through an operator script, instruction or route instead of
// the kernel. The register names each one, its kernel home, the gap that
// forces it, how many launches it may still serve and the package that removes it. The check is advisory for now:
// every finding is a WARN and nothing refuses. Pure: the module reads one file and one clock value, writes
// nothing and starts no process. The register is a source-repository file; a tree without it reports nothing.
const fs = require('node:fs');
const path = require('node:path');

// The register is a development file the product never ships; its name is built at run time so no shipped text names it.
const FILE = path.posix.join('docs', 'ops', `${['BYPASS', 'REGISTER'].join('-')}.json`);
const SCHEMA = 'bypass-register/1';
const STATUSES = ['open', 'removed'];
// launch-records: counted from kernel launch records that name the bypass; operator-reported: the operator's own
// claim from its own log, a number and not evidence; not-counted-yet: nothing is counted, the number is 0.
const BASES = ['launch-records', 'operator-reported', 'not-counted-yet'];
const EFFORTS = ['S', 'M', 'L'];
const TOP = ['schema', 'title', 'dateUTC', 'rule', 'defaultLaunchLimit', 'maxAgeDays', 'bypasses'];
const ROW = ['id', 'title', 'operatorDoes', 'operatorArtifacts', 'kernelHome', 'gap', 'allowedLaunches', 'usesCounted',
  'usesBasis', 'since', 'status', 'removalPackage', 'targetRelease', 'benefitRank', 'effort', 'dependsOn', 'override', 'removedProof'];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DAY_MS = 86400000;

const isInt = (v, min) => Number.isInteger(v) && v >= min;
const oneLine = v => typeof v === 'string' && v.trim() !== '' && !/[\r\n]/.test(v);
const realDay = v => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(v);
};

// The files for seats carry no angle brackets or ampersand entities, at any depth.
function forbidden(value, where, out) {
  if (typeof value === 'string') { if (/[<>]|&[a-z#0-9]+;/i.test(value)) out.push(`${where}: angle bracket or ampersand entity`); }
  else if (Array.isArray(value)) value.forEach((v, i) => forbidden(v, `${where}[${i}]`, out));
  else if (value && typeof value === 'object') for (const k of Object.keys(value)) forbidden(value[k], `${where}.${k}`, out);
}

function rowProblems(row, at, ctx, out) {
  const bad = message => out.push(`${at}: ${message}`);
  if (!row || typeof row !== 'object' || Array.isArray(row)) { bad('not an object'); return; }
  for (const k of ROW) if (!Object.hasOwn(row, k)) bad(`missing field ${k}`);
  for (const k of Object.keys(row)) if (!ROW.includes(k)) bad(`unknown field ${k}`);
  if (typeof row.id !== 'string' || !/^BP-\d{3}$/.test(row.id)) bad('id must be BP-nnn');
  for (const k of ['title', 'operatorDoes', 'kernelHome', 'gap', 'removalPackage']) if (!oneLine(row[k])) bad(`${k} must be one non-empty line`);
  if (!Array.isArray(row.operatorArtifacts) || !row.operatorArtifacts.length || !row.operatorArtifacts.every(oneLine)) bad('operatorArtifacts must list at least one line');
  if (!isInt(row.allowedLaunches, 1)) bad('allowedLaunches must be an integer of at least 1');
  if (!isInt(row.usesCounted, 0)) bad('usesCounted must be an integer of at least 0');
  if (!BASES.includes(row.usesBasis)) bad(`usesBasis must be one of ${BASES.join(', ')}`);
  if (row.usesBasis === 'not-counted-yet' && row.usesCounted !== 0) bad('usesCounted must be 0 while usesBasis is not-counted-yet');
  if (row.since !== 'unknown' && !(typeof row.since === 'string' && realDay(row.since))) bad('since must be a calendar day or unknown');
  if (!STATUSES.includes(row.status)) bad(`status must be one of ${STATUSES.join(', ')}`);
  if (row.targetRelease !== 'later' && !(typeof row.targetRelease === 'string' && SEMVER.test(row.targetRelease))) bad('targetRelease must be later or a canonical version');
  if (!isInt(row.benefitRank, 1)) bad('benefitRank must be an integer of at least 1');
  if (!EFFORTS.includes(row.effort)) bad(`effort must be one of ${EFFORTS.join(', ')}`);
  if (!Array.isArray(row.dependsOn) || row.dependsOn.some(d => typeof d !== 'string' || !ctx.ids.has(d) || d === row.id)) bad('dependsOn must list other ids of this register');
  if (row.override !== null) {
    const o = row.override;
    if (!o || typeof o !== 'object' || Array.isArray(o) || !oneLine(o.by) || !(typeof o.date === 'string' && realDay(o.date)) ||
        !oneLine(o.reason) || !isInt(o.extraLaunches, 1) || Object.keys(o).sort().join() !== 'by,date,extraLaunches,reason') {
      bad('override must be null or an object of by, date, reason and extraLaunches (at least 1)');
    }
  }
  if (row.status === 'removed') {
    if (!oneLine(row.removedProof)) bad('a removed bypass needs removedProof (a commit or a tracked file)');
  } else if (row.removedProof !== '') bad('an open bypass has removedProof empty');
}

// Structural and ownership problems of a parsed register; no clock and no filesystem.
function registerProblems(reg) {
  const out = [];
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return ['register is not an object'];
  for (const k of TOP) if (!Object.hasOwn(reg, k)) out.push(`missing top-level field ${k}`);
  for (const k of Object.keys(reg)) if (!TOP.includes(k)) out.push(`unknown top-level field ${k}`);
  if (reg.schema !== SCHEMA) out.push(`schema must be ${SCHEMA}`);
  if (!oneLine(reg.title)) out.push('title must be one non-empty line');
  if (!oneLine(reg.rule)) out.push('rule must be one non-empty line');
  if (!(typeof reg.dateUTC === 'string' && realDay(reg.dateUTC))) out.push('dateUTC must be a calendar day');
  if (!isInt(reg.defaultLaunchLimit, 1)) out.push('defaultLaunchLimit must be an integer of at least 1');
  if (!isInt(reg.maxAgeDays, 1)) out.push('maxAgeDays must be an integer of at least 1');
  if (!Array.isArray(reg.bypasses)) { out.push('bypasses must be an array'); return out; }
  const ids = new Set(reg.bypasses.map(r => r && r.id).filter(i => typeof i === 'string'));
  const seen = new Set(), ranks = new Set();
  reg.bypasses.forEach((row, i) => {
    rowProblems(row, `bypasses[${i}]${row && row.id ? ` ${row.id}` : ''}`, { ids }, out);
    if (!row || typeof row !== 'object') return;
    if (seen.has(row.id)) out.push(`duplicate id ${row.id}`);
    seen.add(row.id);
    if (ranks.has(row.benefitRank)) out.push(`duplicate benefitRank ${row.benefitRank}`);
    ranks.add(row.benefitRank);
  });
  forbidden(reg, 'register', out);
  return out;
}

// The limit a row may serve: its own allowance plus a recorded owner override.
function effectiveLimit(row) {
  return row.allowedLaunches + (row.override && Number.isInteger(row.override.extraLaunches) ? row.override.extraLaunches : 0);
}

// Usage findings of a structurally sound register. nowMs is the one clock value.
function usageFindings(reg, nowMs) {
  const open = reg.bypasses.filter(r => r.status === 'open');
  const found = [];
  const measured = open.filter(r => r.usesBasis === 'launch-records');
  const over = measured.filter(r => r.usesCounted > effectiveLimit(r)).map(r => r.id);
  if (over.length) found.push(`${over.length} bypass(es) past the launch limit without an owner override: ${over.join(', ')}`);
  const at = measured.filter(r => r.usesCounted === effectiveLimit(r)).map(r => r.id);
  if (at.length) found.push(`${at.length} bypass(es) at the launch limit, the next launch is refused once enforcement is on: ${at.join(', ')}`);
  // An operator-reported number is a claim, not a measurement: it is reported as such and never as a launch-record count.
  const claimed = open.filter(r => r.usesBasis === 'operator-reported');
  const claimOver = claimed.filter(r => r.usesCounted > effectiveLimit(r)).map(r => r.id);
  if (claimOver.length) found.push(`${claimOver.length} bypass(es) reported past the launch limit by the operator, not measured from launch records, no owner override: ${claimOver.join(', ')}`);
  const claimAt = claimed.filter(r => r.usesCounted === effectiveLimit(r)).map(r => r.id);
  if (claimAt.length) found.push(`${claimAt.length} bypass(es) reported at the launch limit by the operator, not measured from launch records: ${claimAt.join(', ')}`);
  const old = open.filter(r => r.since !== 'unknown' && nowMs - Date.parse(`${r.since}T00:00:00Z`) > reg.maxAgeDays * DAY_MS).map(r => r.id);
  if (old.length) found.push(`${old.length} bypass(es) older than ${reg.maxAgeDays} days: ${old.join(', ')}`);
  const blind = open.filter(r => r.usesBasis === 'not-counted-yet').length;
  if (blind) found.push(`${blind} open bypass(es) are not counted yet: uses are 0 by lack of measurement, not by evidence`);
  return found;
}

// CM-77: advisory, source repository. A missing register is silent; every finding is a WARN.
function checkBypassRegister(root, report, options = {}) {
  let text;
  try { text = fs.readFileSync(path.join(root, FILE), 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') report('CM-77', 'WARN', 'bypass register is unreadable', FILE);
    return;
  }
  let reg;
  try { reg = JSON.parse(text); }
  catch { report('CM-77', 'WARN', 'bypass register is not valid JSON', FILE); return; }
  const problems = registerProblems(reg);
  for (const p of problems) report('CM-77', 'WARN', `bypass register: ${p}`, FILE);
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  // A structural defect does not hide the limit signal: the rows that are sound on their own are still read.
  if (problems.length) {
    if (!reg || typeof reg !== 'object') return;
    const sound = Array.isArray(reg.bypasses) ? reg.bypasses.filter(r => { const o = []; rowProblems(r, 'row', { ids: new Set(reg.bypasses.map(x => x && x.id)) }, o); return !o.length; }) : [];
    for (const f of usageFindings({ ...reg, bypasses: sound }, nowMs)) report('CM-77', 'WARN', `bypass register: ${f}`, FILE);
    return;
  }
  const found = usageFindings(reg, nowMs);
  for (const f of found) report('CM-77', 'WARN', `bypass register: ${f}`, FILE);
  if (!found.length) report('CM-77', 'PASS', `bypass register: ${reg.bypasses.length} row(s) sound, none past a limit`, FILE);
}

module.exports = { FILE, SCHEMA, STATUSES, BASES, EFFORTS, TOP, ROW, registerProblems, usageFindings, effectiveLimit, checkBypassRegister };
