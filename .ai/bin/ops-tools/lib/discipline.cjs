'use strict';
// Discipline guards: idle seats while work is ready, a finding owed after a journal marker, a deferral
// past its deadline, a train tip without a recent farm run, an excluded farm host past its review date,
// a silent operator journal, and the facts a finished seat claims. Every guard only makes a
// state visible: none starts work, none removes a verdict, none names a motive. The words are
// IDLE-ALARM, FINDING-OWED, DEFERRAL-OVERDUE, TIP-RUN-DUE, HOST-REVIEW-DUE, OPERATOR-SILENT
// and, for the claims of a report (a warning only), UNVERIFIABLE.
// Budget: one read-only pass under 2 seconds and 100 MB. The pass reads the candidate registry, the
// running markers of the runtime (never a launch output), the deferral journal, the bounded tail of the
// operator journal, the finding headings, the host exclusions, the farm results and up to three git listings.
// It runs no test and no model. The settings are the "discipline" section of the ops-tools config;
// every path in it is relative to the work root; an unset path is a named absent source, never a guess.
const fs = require('node:fs');
const path = require('node:path');
const { parseRegistry } = require('../../lib/candidate-registry.cjs');
const textSafe = require('../../lib/text-safe.cjs');
const protectedPaths = require('../../lib/protected-paths.cjs');
const pathSafe = require('../../lib/path-safe.cjs');
const { secretIn } = require('../../lib/secrets.cjs');

const WORDS = Object.freeze(['IDLE-ALARM', 'FINDING-OWED', 'DEFERRAL-OVERDUE', 'TIP-RUN-DUE', 'HOST-REVIEW-DUE', 'OPERATOR-SILENT']);
// A reserved guard line of the report: data never starts with one of these words (see flat).
const RESERVED = new RegExp(`^(?:${WORDS.join('|')}) `);
const DEFAULTS = Object.freeze({
  idle: { dayMinutes: 30, nightMinutes: 60, readyStatuses: ['ready'], readyMaxAgeHours: 72 },
  night: { startHour: 23, endHour: 7, utcOffsetMinutes: 180 },
  owner: { dayMinutes: 60, nightRepeatMinutes: 240, deferralOverdueMinutes: 720, outboxDir: null, aliveFile: null, aliveMinutes: 15 },
  deferral: { path: 'auto/deferrals.jsonl', overdueMinutes: 120 },
  findings: { journalPath: null, findingsPath: null, owedMinutes: 30, windowHours: 24, tailBytes: 262144,
    markers: ['MISSED STEP', 'MY MISTAKE', 'NOT-COUNTED', 'REFUSED', 'Finding:'] },
  tipRun: { branchPattern: '^land-t[0-9]+[a-z]?$', maxLandings: 3, maxMinutes: 120 },
  hosts: { exclusionsPath: 'farm/host-exclusions.json' },
  operator: { silentMinutes: 45, cooldownMinutes: 45, restart: null },
  stateDir: 'discipline',
  budget: { ms: 2000, rssMB: 100 },
});
const MAX_LINES = 12; // lines per guard in the report; the count of the rest is named
const ITEM = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const HEAD = /^[a-f0-9]{40}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_WORD = /^-?[A-Za-z0-9][A-Za-z0-9._=-]*$/;
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const fail = (code, detail) => { throw Object.assign(new Error(detail || code), { code }); };
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// A value of a source as one printed line of at most 160 characters. A value in which the shared secret scan finds a
// credential shape prints nothing of itself (the scan reads the whole value, before the cut).
const flat = value => {
  if (secretIn(String(value ?? ''))) return '[withheld: credential shape]';
  const text = Array.from(String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')).slice(0, 160).join('');
  return RESERVED.test(text) || text.startsWith('ALARM ') ? `data: ${text}` : text;
};
const minutes = ms => Math.floor(ms / 60000);
const isoMs = value => {
  if (typeof value !== 'string' || !ISO.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z') ? ms : null;
};

// ---- settings ----
function number(value, fallback, lo, hi, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < lo || value > hi) fail('DISCIPLINE-CONFIG-INVALID', key);
  return value;
}
function relPath(value, fallback, key) {
  if (value === undefined) return fallback;
  if (value === null) return null;
  if (typeof value !== 'string' || !SAFE_SCRIPT.test(value) || value.split('/').includes('..') || protectedPaths.hasProtectedName(value)) fail('DISCIPLINE-CONFIG-INVALID', key);
  return value;
}
// The restart command of the operator loop: argv tokens without shell metacharacters, the last one a
// relative script path inside the work root (the loop-runner rule). Never a seat: a seat environment
// never restarts anything (see restartDecision).
function restartArgv(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) fail('DISCIPLINE-CONFIG-INVALID', 'operator.restart');
  for (const token of value.slice(0, -1)) if (typeof token !== 'string' || !SAFE_WORD.test(token)) fail('DISCIPLINE-CONFIG-INVALID', 'operator.restart');
  relPath(value[value.length - 1], null, 'operator.restart');
  return Object.freeze([...value]);
}
function settings(raw) {
  if (raw !== undefined && !plain(raw)) fail('DISCIPLINE-CONFIG-INVALID', 'discipline');
  const r = raw || {};
  const group = key => { if (r[key] !== undefined && !plain(r[key])) fail('DISCIPLINE-CONFIG-INVALID', key); return r[key] || {}; };
  const [idle, night, owner, deferral, findings, tipRun, hosts, operator, budget] =
    ['idle', 'night', 'owner', 'deferral', 'findings', 'tipRun', 'hosts', 'operator', 'budget'].map(group);
  const D = DEFAULTS;
  const strings = (value, fallback, key) => {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || !value.length || value.length > 20 || !value.every(s => typeof s === 'string' && s.trim() && s.length <= 40)) fail('DISCIPLINE-CONFIG-INVALID', key);
    return [...value];
  };
  let pattern = tipRun.branchPattern === undefined ? D.tipRun.branchPattern : tipRun.branchPattern;
  try { if (typeof pattern !== 'string' || !pattern) throw new Error(); new RegExp(pattern); } catch { fail('DISCIPLINE-CONFIG-INVALID', 'tipRun.branchPattern'); }
  if (r.stateDir !== undefined && (typeof r.stateDir !== 'string' || !SAFE_SEGMENT.test(r.stateDir))) fail('DISCIPLINE-CONFIG-INVALID', 'stateDir');
  return {
    idle: { dayMinutes: number(idle.dayMinutes, D.idle.dayMinutes, 1, 1440, 'idle.dayMinutes'),
      nightMinutes: number(idle.nightMinutes, D.idle.nightMinutes, 1, 1440, 'idle.nightMinutes'),
      readyStatuses: strings(idle.readyStatuses, D.idle.readyStatuses, 'idle.readyStatuses'),
      readyMaxAgeHours: number(idle.readyMaxAgeHours, D.idle.readyMaxAgeHours, 1, 24 * 60, 'idle.readyMaxAgeHours') },
    night: { startHour: number(night.startHour, D.night.startHour, 0, 23, 'night.startHour'),
      endHour: number(night.endHour, D.night.endHour, 0, 23, 'night.endHour'),
      utcOffsetMinutes: number(night.utcOffsetMinutes, D.night.utcOffsetMinutes, -720, 840, 'night.utcOffsetMinutes') },
    owner: { dayMinutes: number(owner.dayMinutes, D.owner.dayMinutes, 1, 1440, 'owner.dayMinutes'),
      nightRepeatMinutes: number(owner.nightRepeatMinutes, D.owner.nightRepeatMinutes, 1, 1440, 'owner.nightRepeatMinutes'),
      deferralOverdueMinutes: number(owner.deferralOverdueMinutes, D.owner.deferralOverdueMinutes, 1, 10080, 'owner.deferralOverdueMinutes'),
      outboxDir: relPath(owner.outboxDir, D.owner.outboxDir, 'owner.outboxDir'),
      aliveFile: relPath(owner.aliveFile, D.owner.aliveFile, 'owner.aliveFile'),
      aliveMinutes: number(owner.aliveMinutes, D.owner.aliveMinutes, 1, 1440, 'owner.aliveMinutes') },
    deferral: { path: relPath(deferral.path, D.deferral.path, 'deferral.path'),
      overdueMinutes: number(deferral.overdueMinutes, D.deferral.overdueMinutes, 1, 10080, 'deferral.overdueMinutes') },
    findings: { journalPath: relPath(findings.journalPath, D.findings.journalPath, 'findings.journalPath'),
      findingsPath: relPath(findings.findingsPath, D.findings.findingsPath, 'findings.findingsPath'),
      owedMinutes: number(findings.owedMinutes, D.findings.owedMinutes, 1, 1440, 'findings.owedMinutes'),
      windowHours: number(findings.windowHours, D.findings.windowHours, 1, 168, 'findings.windowHours'),
      tailBytes: number(findings.tailBytes, D.findings.tailBytes, 4096, 4 * 1048576, 'findings.tailBytes'),
      markers: strings(findings.markers, D.findings.markers, 'findings.markers') },
    tipRun: { branchPattern: pattern, maxLandings: number(tipRun.maxLandings, D.tipRun.maxLandings, 1, 100, 'tipRun.maxLandings'),
      maxMinutes: number(tipRun.maxMinutes, D.tipRun.maxMinutes, 1, 1440, 'tipRun.maxMinutes') },
    hosts: { exclusionsPath: relPath(hosts.exclusionsPath, D.hosts.exclusionsPath, 'hosts.exclusionsPath') },
    operator: { silentMinutes: number(operator.silentMinutes, D.operator.silentMinutes, 1, 1440, 'operator.silentMinutes'),
      cooldownMinutes: number(operator.cooldownMinutes, D.operator.cooldownMinutes, 1, 1440, 'operator.cooldownMinutes'),
      restart: restartArgv(operator.restart) },
    stateDir: r.stateDir || D.stateDir,
    budget: { ms: number(budget.ms, D.budget.ms, 100, 60000, 'budget.ms'), rssMB: number(budget.rssMB, D.budget.rssMB, 16, 4096, 'budget.rssMB') },
  };
}

// Night by the local clock of the owner: [startHour, endHour) wrapping midnight.
function isNight(nowMs, night) {
  const hour = new Date(nowMs + night.utcOffsetMinutes * 60000).getUTCHours();
  return night.startHour <= night.endHour ? hour >= night.startHour && hour < night.endHour
    : hour >= night.startHour || hour < night.endHour;
}

// ---- the deferral journal (deferral/1, one JSON row per line; the last row of an item wins) ----
function deferralRow(value) {
  if (!plain(value) || value.schema !== 'deferral/1' || typeof value.item !== 'string' || !ITEM.test(value.item)
    || isoMs(value.at) === null || !['deferred', 'resumed', 'dropped'].includes(value.state)) return null;
  if (value.state !== 'deferred') return { item: value.item, at: value.at, state: value.state };
  const text = v => typeof v === 'string' && v.trim() && v.length <= 400 && !/[\x00-\x1f\x7f]/.test(v);
  if (!text(value.reason) || !text(value.trigger)) return null;
  const ownerHeld = /^owner\b/i.test(value.trigger);
  const deadlineMs = value.deadline === null && ownerHeld ? null : isoMs(value.deadline);
  if (deadlineMs === null && !ownerHeld) return null;
  return { item: value.item, at: value.at, state: 'deferred', reason: value.reason, trigger: value.trigger, deadline: value.deadline, deadlineMs, ownerHeld };
}
function parseDeferrals(text) {
  const latest = new Map();
  const bad = [];
  String(text).replace(/^\uFEFF/, '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row = null;
    try { row = deferralRow(textSafe.parseJsonUnique(line.replace(/\r$/, ''))); } catch { row = null; }
    if (!row) bad.push(i + 1); else latest.set(row.item, row);
  });
  // resumed: the moment each item whose last row resumed it left its hold (a ready moment of the item).
  const resumed = new Map([...latest.values()].filter(r => r.state === 'resumed').map(r => [r.item, isoMs(r.at)]));
  return { open: [...latest.values()].filter(r => r.state === 'deferred').sort((a, b) => cmp(a.item, b.item)), bad, resumed };
}
function deferralLines(deferrals, nowMs, s) {
  if (deferrals.absent) return [`deferral journal: absent (${flat(deferrals.absent)})`];
  if (deferrals.error) return [`deferral journal UNREADABLE: ${flat(deferrals.error)}`];
  const open = deferrals.open;
  const owner = open.filter(r => r.ownerHeld);
  const overdue = open.filter(r => !r.ownerHeld && nowMs - r.deadlineMs > s.deferral.overdueMinutes * 60000);
  const out = [`deferral journal: open=${open.length} ownerHeld=${owner.length} overdue=${overdue.length}${deferrals.bad.length ? ` UNREADABLE lines ${deferrals.bad.slice(0, 10).join(',')}` : ''}`];
  for (const r of overdue.slice(0, MAX_LINES)) out.push(`DEFERRAL-OVERDUE ${flat(r.item)}: ${minutes(nowMs - r.deadlineMs)} min past the deadline ${r.deadline}; trigger ${flat(r.trigger)}; reason ${flat(r.reason)}`);
  if (overdue.length > MAX_LINES) out.push(`deferral overdue not shown: ${overdue.length - MAX_LINES}`);
  for (const r of owner.slice(0, MAX_LINES)) out.push(`deferred ${flat(r.item)}: waits for the owner (${flat(r.trigger)}); reason ${flat(r.reason)}`);
  return out;
}

// ---- idle seats while work is ready ----
// Ready work: a candidate row in a ready status updated within readyMaxAgeHours with no live seat on its
// stream or branch, no queued or running farm run of its head and no open deferral holding it, and every
// open deferral whose deadline has come under the same two conditions (an owner-held deferral is never
// ready). Older ready rows are counted and named, never counted as work.
// Of two ready rows of one branch the later one counts. A branch hold and a stream hold both apply.
// An item became ready at the latest of the moments known for it: the registry update of its row (a
// date alone does not say when in that day: then the first pass that saw the row ready, kept by tick),
// the end of its deferral (the deadline that came, or the row that resumed it), the end of the last
// finished round of its stream or branch and the last finished farm result of its head. With no moment
// known the idle time starts now; a moment ahead of the clock says the item is ready from now at the
// earliest, and the lines count it. A commit time is never a ready moment: an old commit is not idle time.
// The current row of a branch is its latest row of any status (a date alone spans its day; of two rows
// whose times overlap, the later one in the registry): a ready row followed by a building row is no work.
// The ready window runs from the update time, or from the end of the day of a date alone.
// The idle time runs from the later of the last seat start and the earliest ready moment; it alarms only
// with a free seat (the seat policy total minus the live seats and the unreadable markers, each of which
// may be a live seat). No ready work is the normal state.
function registryMs(updated) {
  if (typeof updated !== 'string') return NaN;
  return updated.length === 10 ? Date.parse(`${updated}T00:00:00Z`) : Date.parse(updated);
}
const dateOnly = updated => typeof updated === 'string' && updated.length === 10;
const windowStart = row => { const ms = registryMs(row.updated); return Number.isFinite(ms) ? ms + (dateOnly(row.updated) ? 86400000 : 0) : -Infinity; };
const span = row => { const ms = registryMs(row.updated); return Number.isFinite(ms) ? [ms, windowStart(row)] : [-Infinity, -Infinity]; };
function readyWork(input, nowMs, s) {
  const held = new Map(input.deferrals.open.map(r => [r.item, r]));
  const seenAt = input.readySeen instanceof Map ? input.readySeen : new Map();
  const resumed = input.deferrals.resumed instanceof Map ? input.deferrals.resumed : new Map();
  const live = new Set(input.seats.live.flatMap(m => [m.stream, m.task].filter(Boolean)));
  const ended = input.seats.ended instanceof Map ? input.seats.ended : new Map();
  const tip = input.tip || {};
  const heads = tip.heads instanceof Map ? tip.heads : new Map();
  const headRuns = tip.headRuns instanceof Map ? tip.headRuns : new Map();
  const inFlight = tip.inFlight instanceof Set ? tip.inFlight : new Set();
  const landedSet = tip.landed instanceof Set ? tip.landed : new Set();
  const headOf = (branch, sha) => HEAD.test(sha || '') ? sha : heads.get(branch) || null;
  let stale = 0, landed = 0, ahead = 0;
  // The moments of one item; NaN is not known, and a moment ahead of the clock makes the item ready from now.
  const readyAt = (names, head, floor) => {
    const known = [floor, ...names.flatMap(n => [ended.get(n), resumed.get(n)]), head ? headRuns.get(head) : undefined].filter(Number.isFinite);
    if (known.some(ms => ms > nowMs)) { ahead++; return nowMs; }
    return known.length ? Math.max(...known) : null;
  };
  const items = [];
  const seen = new Set();
  const newest = new Map();
  for (const row of input.candidates) {
    const prev = newest.get(row.branch);
    if (!prev || !(span(row)[1] < span(prev)[0])) newest.set(row.branch, row);
  }
  for (const row of input.candidates) {
    if (!s.idle.readyStatuses.includes(row.status) || newest.get(row.branch) !== row || seen.has(row.branch)) continue;
    if (landedSet.has(row.branch)) { seen.add(row.branch); seen.add(row.stream); landed++; continue; }
    const updatedMs = registryMs(row.updated);
    // An old ready row is no work, but a deferral of the same item whose deadline came still is.
    if (!Number.isFinite(updatedMs) || nowMs - windowStart(row) > s.idle.readyMaxAgeHours * 3600000) { stale++; continue; }
    seen.add(row.branch); seen.add(row.stream);
    const head = headOf(row.branch, row.sha);
    if (live.has(row.stream) || live.has(row.branch) || (head && inFlight.has(head))) continue;
    const holds = [held.get(row.branch), held.get(row.stream)].filter(Boolean);
    if (holds.some(h => h.ownerHeld || h.deadlineMs > nowMs)) continue;
    const seenMs = seenAt.get(row.branch);
    const updateMs = !dateOnly(row.updated) ? updatedMs : Number.isFinite(seenMs) ? Math.max(updatedMs, seenMs) : -Infinity;
    const since = readyAt([row.branch, row.stream], head, Math.max(updateMs, ...holds.map(h => h.deadlineMs)));
    items.push({ item: row.branch, since: since === null ? nowMs : since, from: 'candidate' });
  }
  for (const r of input.deferrals.open) {
    if (r.ownerHeld || r.deadlineMs > nowMs || seen.has(r.item)) continue;
    const head = headOf(r.item, null);
    if (live.has(r.item) || (head && inFlight.has(head))) continue;
    items.push({ item: r.item, since: readyAt([r.item], head, r.deadlineMs) ?? nowMs, from: 'deferral' });
  }
  return { items: items.sort((a, b) => a.since - b.since || cmp(a.item, b.item)), stale, landed, ahead };
}
function idleState(input, nowMs, s) {
  const night = isNight(nowMs, s.night);
  const threshold = night ? s.idle.nightMinutes : s.idle.dayMinutes;
  const { items, stale, landed, ahead } = readyWork(input, nowMs, s);
  const total = input.seats.total;
  const busy = Number.isSafeInteger(input.seats.unreadable) ? input.seats.unreadable : 0;
  const free = Number.isSafeInteger(total) ? Math.max(0, total - input.seats.live.length - busy) : null;
  const since = items.length ? Math.max(items[0].since, input.seats.lastStartMs || 0) : null;
  const idleMinutes = since === null ? 0 : Math.max(0, minutes(nowMs - since));
  const alarm = items.length > 0 && free !== null && free > 0 && idleMinutes >= threshold;
  return { night, threshold, items, stale, landed, ahead, free, idleMinutes, alarm };
}
function idleLines(state, input) {
  const freeText = state.free === null ? `UNKNOWN (${flat(input.seats.totalError || 'no seat total')})` : state.free;
  const names = state.items.slice(0, 5).map(i => `${flat(i.item)} (${i.from})`).join(', ');
  const head = `ready=${state.items.length} freeSeats=${freeText} idleMinutes=${state.idleMinutes} threshold=${state.threshold} ${state.night ? 'night' : 'day'}`;
  const out = [state.alarm ? `IDLE-ALARM ${head}: ${names}` : `idle check: ${head}${state.items.length ? `: ${names}` : ' (no ready work: normal)'}`];
  if (state.stale) out.push(`ready rows older than the ready window: ${state.stale} (not counted as work; mark them or defer them)`);
  if (state.landed) out.push(`ready rows of landed branches: ${state.landed} (not counted as work; mark them landed)`);
  if (state.ahead) out.push(`ready moments ahead of the clock: ${state.ahead} (idle counted from now; check the clock of the source)`);
  if (input.seats.unreadable) out.push(`running markers UNREADABLE: ${flat(input.seats.unreadable)}${Number.isSafeInteger(input.seats.unreadable) ? ' (each counted as a busy seat)' : ''}`);
  if (input.candidatesError) out.push(`candidate registry UNREADABLE: ${flat(input.candidatesError)} (ready rows not counted)`);
  return out;
}

// ---- a finding owed after a journal marker ----
// Journal lines are "- HH:MMZ text" (a minute digit may be x). The date of the newest line is the date of
// the file time; walking back, a later clock reading than the line after it is the day before. A marker
// line is settled by a finding number (a heading "## N.NNN" of the findings file) first named on it or on a
// later line; one new number settles one open marker, the oldest first, and a range N.AAA-BBB names each.
const LINE = /^- ([01][0-9]|2[0-3]):([0-5][0-9x])Z\b(.*)$/;
function findingIds(text) {
  const ids = new Set();
  for (const m of String(text).matchAll(/^## ([0-9]{1,3}\.[0-9]{3})\b/gm)) ids.add(m[1]);
  return ids;
}
function namedIds(text, known) {
  const out = [];
  for (const m of text.matchAll(/(?<![0-9.])([0-9]{1,3})\.([0-9]{3})(?:-(?:\1\.)?([0-9]{3}))?(?![0-9])/g)) {
    const from = Number(m[2]), to = m[3] === undefined ? from : Number(m[3]);
    for (let n = from; n <= Math.min(to, from + 200); n++) {
      const id = `${m[1]}.${String(n).padStart(3, '0')}`;
      if (known.has(id)) out.push(id);
    }
  }
  return out;
}
function journalLines(tail, mtimeMs) {
  const rows = [];
  for (const raw of String(tail).replace(/^\uFEFF/, '').split('\n')) {
    const m = LINE.exec(raw.replace(/\r$/, ''));
    if (m) rows.push({ clock: Number(m[1]) * 60 + Number(m[2].replace('x', '0')), text: m[3].trim() });
  }
  let day = Date.parse(`${new Date(mtimeMs).toISOString().slice(0, 10)}T00:00:00Z`);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (i < rows.length - 1 && rows[i].clock > rows[i + 1].clock) day -= 86400000;
    rows[i].ms = day + rows[i].clock * 60000;
  }
  return rows;
}
function owedFindings(journal, known, nowMs, s) {
  const seen = new Set();
  const open = [];
  const markers = s.findings.markers;
  for (const row of journal) {
    if (markers.some(word => row.text.includes(word))) open.push(row);
    const fresh = [...new Set(namedIds(row.text, known))].filter(id => !seen.has(id));
    for (const id of fresh) seen.add(id);
    open.splice(0, Math.min(fresh.length, open.length));
  }
  return open.filter(r => nowMs - r.ms >= s.findings.owedMinutes * 60000 && nowMs - r.ms <= s.findings.windowHours * 3600000);
}
function findingLines(source, nowMs, s) {
  if (source.absent) return [`finding check: absent (${flat(source.absent)})`];
  if (source.error) return [`finding check UNREADABLE: ${flat(source.error)}`];
  const owed = owedFindings(source.journal, source.known, nowMs, s);
  const out = [`finding check: markers owed=${owed.length} (a finding number within ${s.findings.owedMinutes} min of a marker)`];
  for (const r of owed.slice(0, MAX_LINES)) out.push(`FINDING-OWED ${new Date(r.ms).toISOString().slice(0, 16)}Z (${minutes(nowMs - r.ms)} min): ${flat(r.text)}`);
  if (owed.length > MAX_LINES) out.push(`findings owed not shown: ${owed.length - MAX_LINES}`);
  return out;
}

// ---- the farm run rhythm of the train tip ----
// The train is the newest local branch matching branchPattern; its landings are the commits of
// line..train. The last run is the newest finished farm suite or shard result whose job SHA is one of them.
function tipLines(tip, nowMs, s) {
  if (tip.error) return [`tip run UNREADABLE: ${flat(tip.error)}`];
  if (!tip.train) return ['tip run: no train branch'];
  if (!tip.landings.length) return [`tip run: train ${flat(tip.train)} has no landing beyond the line`];
  const at = tip.landings.findIndex(c => tip.runs.has(c.sha));
  const since = at < 0 ? tip.landings.length : at;
  const fromMs = at < 0 ? tip.landings[tip.landings.length - 1].ms : tip.runs.get(tip.landings[at].sha);
  const age = Math.max(0, minutes(nowMs - fromMs));
  const queued = tip.queued.has(tip.landings[0].sha);
  const head = `train=${flat(tip.train)} tip=${tip.landings[0].sha.slice(0, 8)} lastRun=${at < 0 ? 'none' : tip.landings[at].sha.slice(0, 8)} landingsSince=${since} minutesSince=${age}${queued ? ' tipQueued=yes' : ''}`;
  const due = !queued && since > 0 && (since > s.tipRun.maxLandings || age > s.tipRun.maxMinutes);
  return [due ? `TIP-RUN-DUE ${head} (limit ${s.tipRun.maxLandings} landings or ${s.tipRun.maxMinutes} min)` : `tip run: ${head}`];
}

// ---- farm hosts excluded with a reason and a review date (host-exclusions/1) ----
function exclusionLines(source, nowMs) {
  if (source.absent) return [`host exclusions: absent (${flat(source.absent)})`];
  if (source.error) return [`host exclusions UNREADABLE: ${flat(source.error)}`];
  const data = source.data;
  if (!plain(data) || data.schema !== 'host-exclusions/1' || !Array.isArray(data.hosts)) return ['host exclusions UNREADABLE: SHAPE'];
  const out = [`host exclusions: ${data.hosts.length}`];
  // The first 40 hosts are shown; beyond them a due host is still shown (up to MAX_LINES) and the rest is counted.
  let hidden = 0, hiddenDue = 0, beyond = 0;
  data.hosts.forEach((h, i) => {
    const host = plain(h) && typeof h.host === 'string' && h.host ? flat(h.host) : 'UNKNOWN';
    const reason = plain(h) && typeof h.reason === 'string' && h.reason.trim() ? flat(h.reason) : 'no reason';
    const review = plain(h) ? isoMs(h.reviewAt) : null;
    const due = review === null || review <= nowMs;
    if (i >= 40 && (!due || beyond >= MAX_LINES)) { hidden++; if (due) hiddenDue++; return; }
    if (i >= 40) beyond++;
    if (review === null) out.push(`HOST-REVIEW-DUE ${host}: no review date; ${reason}`);
    else if (due) out.push(`HOST-REVIEW-DUE ${host}: review date ${h.reviewAt} passed ${minutes(nowMs - review)} min ago; ${reason}`);
    else out.push(`host excluded ${host}: review ${h.reviewAt}; ${reason}`);
  });
  if (hidden) out.push(`host exclusions not shown: ${hidden} (due among them: ${hiddenDue})`);
  return out;
}

// ---- the operator journal silence ----
function silence(source, nowMs, s) {
  if (source.absent || source.error || !Number.isFinite(source.mtimeMs)) return { known: false, minutes: null };
  const quiet = Math.max(0, minutes(nowMs - source.mtimeMs));
  return { known: true, minutes: quiet, silent: quiet > s.operator.silentMinutes };
}
function silenceLines(state, s) {
  if (!state.known) return ['operator journal: UNKNOWN (no readable journal configured)'];
  return [state.silent ? `OPERATOR-SILENT ${state.minutes} min without a journal line (limit ${s.operator.silentMinutes} min)`
    : `operator journal: last line ${state.minutes} min ago`];
}

function evaluate(input, nowMs, s) {
  const idle = idleState(input, nowMs, s);
  const quiet = silence(input.journal, nowMs, s);
  const lines = [...idleLines(idle, input), ...deferralLines(input.deferrals, nowMs, s), ...findingLines(input.findings, nowMs, s),
    ...tipLines(input.tip, nowMs, s), ...exclusionLines(input.exclusions, nowMs), ...silenceLines(quiet, s)];
  return { idle, quiet, lines };
}

// ---- lean acquisition (read-only) ----
function readBounded(file, io, maxBytes) {
  const st = io.statSync(file);
  if (!st.isFile()) fail('DISCIPLINE-SOURCE-NOT-FILE');
  if (st.nlink > 1) fail('DISCIPLINE-SOURCE-LINK');
  const start = Math.max(0, st.size - maxBytes);
  const fd = io.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(st.size - start);
    let got = 0;
    while (got < buffer.length) { const n = io.readSync(fd, buffer, got, buffer.length - got, start + got); if (!n) break; got += n; }
    let text = buffer.subarray(0, got).toString('utf8');
    if (start) text = text.slice(text.indexOf('\n') + 1); // a cut first line is never read as a line
    return { text, mtimeMs: st.mtimeMs, size: st.size };
  } finally { io.closeSync(fd); }
}
// A path under the base by its real path: a link or a junction on the way, or a file with a second hard
// link, never leads a read or a write out of the base.
function inside(base, rel) {
  const file = path.resolve(base, rel);
  const back = path.relative(base, file);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) fail('DISCIPLINE-PATH-OUTSIDE');
  const real = pathSafe.realInside(base, file, { refuseHardlinks: true });
  if (!real.ok) fail('DISCIPLINE-PATH-OUTSIDE', real.reason);
  return real.real;
}
// A name found in a listed directory (a marker, a result folder, a job record): never a link or a junction,
// never a file with a second hard link. A refused name is read as unreadable, never followed.
function leaf(file, io, kind = 'file') {
  const st = io.lstatSync(file);
  if (st.isSymbolicLink() || (kind === 'dir' ? !st.isDirectory() : !st.isFile() || st.nlink > 1)) fail('DISCIPLINE-PATH-OUTSIDE');
  return st;
}
const readLeaf = (file, io) => { leaf(file, io); return io.readFileSync(file, 'utf8'); };
function optional(base, rel, fn) {
  if (rel === null) return { absent: 'not configured' };
  try { return fn(inside(base, rel)); } catch (e) { return e.code === 'ENOENT' ? { absent: rel } : { error: e.code || 'INVALID' }; }
}
// Live seats: a running marker of the last maxAgeHours whose pid answers and that has no terminal record
// of the same start. The last seat start is the newest startedAt among the markers read. A finished round
// is a marker that ended (its terminal record of the same start, else its end mark); its end is the
// endedAt of the terminal record, else the time of the record that ended it, kept per stream and task (an
// end ahead of the clock is kept: the item is then ready from now, see readyWork). A marker that cannot be
// read, or that is a link, counts as unreadable: the caller counts it as a busy seat.
function readSeats(runtime, io, nowMs, kill, maxAgeMs) {
  const names = io.readdirSync(runtime).filter(n => n.endsWith('.running.json')).sort(cmp);
  const live = [];
  const ended = new Map();
  const finish = (marker, endMs) => {
    if (!Number.isFinite(endMs)) return;
    for (const key of [marker.stream, marker.task]) if (typeof key === 'string' && key) ended.set(key, Math.max(ended.get(key) || 0, endMs));
  };
  let lastStartMs = null, unreadable = 0;
  for (const name of names) {
    const file = path.join(runtime, name);
    let st;
    try { st = leaf(file, io); } catch { unreadable++; continue; }
    if (nowMs - st.mtimeMs > maxAgeMs) continue;
    let marker;
    try { marker = textSafe.parseJsonUnique(io.readFileSync(file, 'utf8')); } catch { unreadable++; continue; }
    const started = plain(marker) ? isoMs(marker.startedAt) : null;
    if (started === null || !Number.isSafeInteger(marker.wrapperPid) || marker.wrapperPid <= 0) { unreadable++; continue; }
    if (started <= nowMs) lastStartMs = Math.max(lastStartMs || 0, started);
    const terminal = path.join(runtime, name.replace(/\.running\.json$/, '.terminal.json'));
    let closed = null;
    try {
      const t = textSafe.parseJsonUnique(readLeaf(terminal, io));
      if (plain(t) && t.wrapperPid === marker.wrapperPid && t.startedAt === marker.startedAt) closed = isoMs(t.endedAt) ?? io.lstatSync(terminal).mtimeMs;
    } catch { closed = null; }
    if (closed !== null || marker.ended) { finish(marker, closed !== null ? closed : st.mtimeMs); continue; }
    let alive = false;
    try { kill(marker.wrapperPid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
    if (alive) live.push({ name: name.replace(/\.running\.json$/, ''), stream: typeof marker.stream === 'string' ? marker.stream : null, task: typeof marker.task === 'string' ? marker.task : null });
  }
  return { live, lastStartMs, unreadable, ended };
}
// opts: { nowMs, shas, maxAgeMs }. heads: the head SHA of every local branch. headRuns: the newest finished
// farm result (any kind) of a head of a branch or of a SHA in opts.shas. inFlight: those heads with a queued
// job or a result directory without its done record whose file is younger than maxAgeMs (a run in progress); an
// older queue file is a plan left behind, not a run. A result folder or a record that is a link is not read.
// A result time ahead of the clock is no run of the train tip (its rhythm stays due); as a ready moment it
// makes the item ready from now.
function readTip(results, queueDir, io, git, pattern, lineRef, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const maxAgeMs = opts.maxAgeMs || 12 * 3600000;
  const re = new RegExp(pattern);
  const branches = git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:unix)%09%(objectname)', 'refs/heads']).split('\n')
    .map(l => l.split('\t')).filter(([b, t]) => b && Number.isFinite(Number(t)));
  const heads = new Map(branches.filter(([, , sha]) => HEAD.test(sha || '')).map(([b, , sha]) => [b, sha]));
  const trains = branches.filter(([b]) => re.test(b)).sort((a, b) => Number(b[1]) - Number(a[1]) || cmp(a[0], b[0]));
  const tip = { train: trains.length ? trains[0][0] : null, landings: [], runs: new Map(), queued: new Set(), landed: new Set(),
    heads, headRuns: new Map(), inFlight: new Set() };
  // A branch landed as one commit is named by the subject "land BRANCH as one commit" on the line or the train.
  const subjects = git(['log', '--max-count=400', '--format=%s', lineRef, ...(tip.train ? [`refs/heads/${tip.train}`] : []), '--']);
  for (const m of subjects.matchAll(/^land (\S+) as one commit\b/gm)) tip.landed.add(m[1]);
  if (tip.train) tip.landings = git(['log', '--max-count=200', '--format=%H%x09%ct', `${lineRef}..refs/heads/${tip.train}`, '--'])
    .split('\n').filter(Boolean).map(l => { const [sha, t] = l.split('\t'); return { sha, ms: Number(t) * 1000 }; });
  const wanted = new Set(tip.landings.map(c => c.sha));
  const headShas = new Set([...heads.values(), ...(opts.shas || []).filter(sha => HEAD.test(sha))]);
  const readJson = file => textSafe.parseJsonUnique(readLeaf(file, io));
  let names = [];
  try { names = io.readdirSync(results); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of names) {
    const jobFile = path.join(results, name, 'job.json');
    let done, job;
    try { leaf(path.join(results, name), io, 'dir'); job = readJson(jobFile); } catch { continue; }
    if (!plain(job) || typeof job.sha !== 'string' || (!wanted.has(job.sha) && !headShas.has(job.sha))) continue;
    try { done = readJson(path.join(results, name, 'done.json')); } catch (e) {
      if (e.code === 'ENOENT' && headShas.has(job.sha)) {
        try { if (nowMs - io.lstatSync(jobFile).mtimeMs <= maxAgeMs) tip.inFlight.add(job.sha); } catch { /* gone meanwhile: not in flight */ }
      }
      continue;
    }
    const at = plain(done) ? isoMs(done.at) : null;
    if (at === null) continue;
    if (['suite', 'shard'].includes(job.kind) && wanted.has(job.sha) && at <= nowMs && at > (tip.runs.get(job.sha) || 0)) tip.runs.set(job.sha, at);
    if (headShas.has(job.sha) && at > (tip.headRuns.get(job.sha) || 0)) tip.headRuns.set(job.sha, at);
  }
  let queue = [];
  try { queue = io.readdirSync(queueDir).filter(n => n.endsWith('.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  for (const name of queue) {
    try {
      const file = path.join(queueDir, name);
      const job = readJson(file);
      if (!plain(job) || nowMs - io.lstatSync(file).mtimeMs > maxAgeMs) continue;
      if (wanted.has(job.sha)) tip.queued.add(job.sha);
      if (headShas.has(job.sha)) tip.inFlight.add(job.sha);
    } catch { /* an unreadable queue file is the pulse's to name */ }
  }
  return tip;
}
// A directory a pass lists (the runtime, the farm results, the farm queue) by its real path: under its base every
// segment, the directory itself included, is no link and no junction; without a base the directory itself is none.
// A missing one is listed as empty by its caller.
function listedDir(dir, base, io) {
  if (base) return inside(base, path.relative(base, dir));
  let st;
  try { st = io.lstatSync(dir); } catch (e) { if (e.code === 'ENOENT') return dir; throw e; }
  if (st.isSymbolicLink() || !st.isDirectory()) fail('DISCIPLINE-PATH-OUTSIDE');
  return dir;
}
// opts: { workRoot, runtime, mainRoot, settings, nowMs, io, git, kill, seatTotal, maxAgeMs, lineRef, resultsDir, queueDir, readySeen }
// An unreadable runtime leaves the free seats unknown: its live seats are not known, so none is counted free;
// a single unreadable marker counts as one busy seat. The registry is read as a leaf of the runtime.
function acquire(opts) {
  const io = opts.io || fs;
  const s = opts.settings;
  const nowMs = opts.nowMs;
  const input = { readySeen: opts.readySeen instanceof Map ? opts.readySeen : new Map() };
  let runtime = null, runtimeError = null;
  try { runtime = listedDir(opts.runtime, opts.mainRoot, io); } catch (e) { runtimeError = e.code || 'INVALID'; }
  try {
    if (runtimeError) fail(runtimeError);
    input.candidates = parseRegistry(readLeaf(path.join(runtime, 'CANDIDATES.md'), io)).rows
      .map(({ cells: c }) => ({ stream: c[0], branch: c[1], sha: c[2], status: c[4], updated: c[5] }));
    input.candidatesError = null;
  } catch (e) { input.candidates = []; input.candidatesError = e.code || 'INVALID'; }
  try {
    if (runtimeError) fail(runtimeError);
    const seats = readSeats(runtime, io, nowMs, opts.kill || process.kill, opts.maxAgeMs || 12 * 3600000);
    input.seats = { ...seats, total: null, totalError: null };
  } catch (e) { input.seats = { live: [], lastStartMs: null, unreadable: e.code || 'INVALID', ended: new Map(), total: null, totalError: 'runtime unreadable' }; }
  if (input.seats.totalError === null) try {
    const total = typeof opts.seatTotal === 'function' ? opts.seatTotal() : opts.seatTotal;
    if (Number.isSafeInteger(total) && total >= 0) input.seats.total = total; else input.seats.totalError = 'seat policy total unset';
  } catch (e) { input.seats.totalError = `seat policy ${e.code || 'unreadable'}`; }
  input.deferrals = optional(opts.workRoot, s.deferral.path, file => ({ ...parseDeferrals(readBounded(file, io, 8 * 1048576).text) }));
  if (!input.deferrals.open) input.deferrals = { open: [], bad: [], ...input.deferrals };
  input.journal = optional(opts.workRoot, s.findings.journalPath, file => readBounded(file, io, s.findings.tailBytes));
  input.findings = input.journal.absent || input.journal.error ? { absent: input.journal.absent, error: input.journal.error }
    : optional(opts.workRoot, s.findings.findingsPath, file => ({ known: findingIds(readBounded(file, io, 8 * 1048576).text),
      journal: journalLines(input.journal.text, input.journal.mtimeMs) }));
  try {
    const dir = (rel, fallback) => listedDir(path.resolve(opts.workRoot, rel || fallback), opts.workRoot, io);
    input.tip = readTip(dir(opts.resultsDir, 'farm/results'), dir(opts.queueDir, 'farm/queue'), io, opts.git, s.tipRun.branchPattern, opts.lineRef || 'origin/v2.0.0',
      { nowMs, shas: input.candidates.map(c => c.sha), maxAgeMs: opts.maxAgeMs });
  }
  catch (e) { input.tip = { error: e.code || 'GIT', landings: [], runs: new Map(), queued: new Set(), landed: new Set(), heads: new Map(), headRuns: new Map(), inFlight: new Set() }; }
  input.exclusions = optional(opts.workRoot, s.hosts.exclusionsPath, file => ({ data: textSafe.parseJsonUnique(readBounded(file, io, 1048576).text) }));
  return input;
}

// ---- the own prose of a Markdown report (the claims of a finished seat) ----
// The text a report states itself, by the CommonMark block structure: its paragraphs (a table row is a paragraph of
// its own), headings and thematic breaks, in list items too, without their container marks. Code (a fenced block,
// one left open runs to the end of its container; an indented block, which never interrupts a paragraph), an HTML
// block (a comment, pre, script, style or textarea, a declaration, a processing instruction, CDATA, a block-level
// tag, or a tag alone on its line, which never interrupts a paragraph) and a block quote with the lazy lines that
// continue its paragraph are an example or the words of someone else: never read. Inside a paragraph an HTML comment
// closed before the paragraph ends is hidden; a code span keeps its text. A tab advances to the next multiple of four.
// lines: every prose line in order (a heading and a border keep their line); blocks: each own text block as one text
// (a paragraph, a table row, the text of a heading); places: for each block the [offset, line] pairs where each of its
// source lines starts in its text (the line of the report, from 1).
const HTML_BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt '
  + 'fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem '
  + 'nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));
const HTML_TAG_LINE = /^(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:[^ \t"'=<>`]+|'[^']*'|"[^"]*"))?)*[ \t]*\/?>|<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$/;
// The end of the HTML block a line starts ('blank': the next blank line), or null.
function htmlBlock(text, inParagraph) {
  if (/^<(?:pre|script|style|textarea)(?:[ \t>]|$)/i.test(text)) return /<\/(?:pre|script|style|textarea)>/i;
  if (text.startsWith('<!--')) return /-->/;
  if (text.startsWith('<?')) return /\?>/;
  if (text.startsWith('<![CDATA[')) return /\]\]>/;
  if (/^<![A-Za-z]/.test(text)) return />/;
  const tag = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t]|\/?>|$)/.exec(text);
  if (tag && HTML_BLOCK_TAGS.has(tag[1].toLowerCase())) return 'blank';
  return !inParagraph && HTML_TAG_LINE.test(text) ? 'blank' : null;
}
// The mark of a line that opens a fenced block, or null: a backtick fence whose info string holds a backtick is text.
const fenceOpen = body => { const m = /^(`{3,}|~{3,})(.*)$/.exec(body); return m && !(m[1][0] === '`' && m[2].includes('`')) ? m[1] : null; };
const columns = line => { let out = ''; for (const ch of line) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ch; return out; };
const indentOf = text => /^ */.exec(text)[0].length;
// A paragraph without the HTML comments closed inside it (a code span and a backslash keep a comment opener literal).
function withoutComments(text) {
  let out = '';
  for (let k = 0; k < text.length;) {
    if (text[k] === '\\') { out += text.slice(k, k + 2); k += 2; continue; }
    if (text[k] === '`') {
      const run = /^`+/.exec(text.slice(k))[0];
      const close = text.slice(k + run.length).search(new RegExp(`(?<!\`)${run}(?!\`)`));
      const end = close < 0 ? k + run.length : k + run.length + close + run.length;
      out += text.slice(k, end); k = end; continue;
    }
    const end = text.startsWith('<!--', k) ? text.indexOf('-->', k + 2) : -1;
    if (end >= 0) { out += text.slice(k, end + 3).replace(/[^\n]/g, ' '); k = end + 3; continue; }
    out += text[k++];
  }
  return out;
}
// True when a line starts a block other than a paragraph: a quote, a list item, a fence, an HTML block, a heading or a
// break (an empty item, an ordered one from another number than 1, and a lone tag never interrupt a paragraph).
function startsBlock(text, inParagraph) {
  const body = text.slice(indentOf(text));
  if (indentOf(text) >= 4) return false;
  if (/^>|^#{1,6}(?: |$)|^([-*_])(?: *\1){2,} *$/.test(body) || fenceOpen(body) || htmlBlock(body, inParagraph)) return true;
  const item = /^([-+*]|([0-9]{1,9})[.)])( +|$)/.exec(body);
  return Boolean(item) && (!inParagraph || (Boolean(body.slice(item[0].length).trim()) && (item[2] === undefined || Number(item[2]) === 1)));
}
function ownProse(text) {
  const lines = [], blocks = [], places = [];
  const stack = []; // open containers: { quote: true } or { item: content column }
  let leaf = null; // { kind: 'para', quoted, lines, line } | { kind: 'fence', mark } | { kind: 'html', end } | { kind: 'code' }
  let n = 0; // the line of the report being read
  const quoted = () => stack.some(c => c.quote);
  const close = () => {
    if (leaf && leaf.kind === 'para' && !leaf.quoted) {
      const own = withoutComments(leaf.lines.join('\n')).split('\n');
      lines.push(...own);
      // A paragraph takes consecutive lines of the report (a blank line ends it).
      if (own.every(l => l.trim().startsWith('|'))) own.forEach((l, k) => { blocks.push(l); places.push([[0, leaf.line + k]]); });
      else {
        let from = 0;
        places.push(own.map((l, k) => { const at = [from, leaf.line + k]; from += l.length + 1; return at; }));
        blocks.push(own.join(' '));
      }
    }
    leaf = null;
  };
  const say = line => { if (!quoted()) lines.push(line); };
  for (const raw of String(text).split('\n')) {
    n++;
    const line = columns(raw.replace(/\r$/, ''));
    let pos = 0, matched = 0;
    for (const c of stack) {
      const rest = line.slice(pos);
      if (c.quote) {
        const m = /^ {0,3}>/.exec(rest);
        if (!m) break;
        pos += m[0].length + (line[pos + m[0].length] === ' ' ? 1 : 0);
      } else if (rest.trim() && indentOf(rest) < c.item) break;
      else pos += Math.min(c.item, indentOf(rest));
      matched++;
    }
    let rest = line.slice(pos);
    const blank = !rest.trim();
    if (leaf && matched === stack.length) {
      if (leaf.kind === 'fence') {
        const end = /^ {0,3}(`{3,}|~{3,}) *$/.exec(rest);
        if (end && end[1][0] === leaf.mark[0] && end[1].length >= leaf.mark.length) leaf = null;
        continue;
      }
      if (leaf.kind === 'html') { if (leaf.end === 'blank' ? blank : leaf.end.test(rest)) leaf = null; continue; }
      if (leaf.kind === 'code' && (blank || indentOf(rest) >= 4)) continue;
    }
    if (leaf && leaf.kind === 'para' && matched < stack.length && !blank && !startsBlock(rest, true)) { leaf.lines.push(rest.trim()); continue; }
    if (matched < stack.length) { close(); stack.length = matched; }
    for (;;) {
      const at = indentOf(rest);
      if (at >= 4) break;
      const body = rest.slice(at);
      if (body[0] === '>') { close(); stack.push({ quote: true }); rest = body.slice(body[1] === ' ' ? 2 : 1); continue; }
      if (/^([-*_])(?: *\1){2,} *$/.test(body)) break;
      const item = /^([-+*]|([0-9]{1,9})[.)])( +|$)/.exec(body);
      const para = leaf && leaf.kind === 'para';
      if (!item || (para && !startsBlock(body, true))) break;
      const after = body.slice(item[0].length), width = at + item[1].length, gap = item[3].length;
      close();
      if (!after.trim()) { stack.push({ item: width + 1 }); rest = ''; }
      else if (gap > 4) { stack.push({ item: width + 1 }); rest = `${' '.repeat(gap - 1)}${after}`; }
      else { stack.push({ item: width + gap }); rest = after; }
    }
    if (!rest.trim()) { if (leaf && leaf.kind === 'para') close(); continue; }
    const para = leaf && leaf.kind === 'para';
    const at = indentOf(rest);
    if (at >= 4) { if (para) leaf.lines.push(rest.trim()); else if (!leaf || leaf.kind !== 'code') { close(); leaf = { kind: 'code' }; } continue; }
    const body = rest.slice(at);
    const fence = fenceOpen(body);
    if (fence) { close(); leaf = { kind: 'fence', mark: fence }; continue; }
    const html = htmlBlock(body, para);
    if (html) { close(); leaf = html !== 'blank' && html.test(body.slice(2)) ? null : { kind: 'html', end: html }; continue; }
    if (/^#{1,6}(?: |$)/.test(body)) {
      close(); say(body);
      if (!quoted()) { blocks.push(withoutComments(body.replace(/^#{1,6}/, '').replace(/(?:^|[ \t])#+[ \t]*$/, '')).trim()); places.push([[0, n]]); }
      continue;
    }
    if (para && /^(?:=+|-+) *$/.test(body)) { close(); say(body); continue; }
    if (/^([-*_])(?: *\1){2,} *$/.test(body)) { close(); say(body); continue; }
    if (para) leaf.lines.push(body);
    else { close(); leaf = { kind: 'para', quoted: quoted(), lines: [body], line: n }; }
  }
  close();
  return { lines, blocks, places };
}
// The line of the report at an offset of an own block (its places).
const lineAt = (place, offset) => place.reduce((line, [from, at]) => (from <= offset ? at : line), place[0][1]);

module.exports = { WORDS, RESERVED, DEFAULTS, settings, isNight, deferralRow, parseDeferrals, deferralLines, readyWork, idleState, idleLines,
  findingIds, namedIds, journalLines, owedFindings, findingLines, tipLines, exclusionLines, silence, silenceLines, evaluate,
  readBounded, readSeats, readTip, acquire, flat, isoMs, inside, leaf, readLeaf, ownProse, lineAt };
