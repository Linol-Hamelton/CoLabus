'use strict';
// PULSE canonical readers (r1/op7), one interpretation per source.
// Encoding: UTF-8, no BOM, NFC, no control data (TAB/LF syntax is allowed),
// invisible/format characters or lone
// surrogates. LF and CRLF are accepted; a final newline is optional.
// Register: unique JSON keys at every depth; root.items is an array of objects
// with OR-[0-9]{4} ids. Status is exactly open|partial|unknown|closed|withdrawn;
// missing, typed, placeholder and other statuses become UNKNOWN. Repeated ids
// with disagreeing statuses become one UNKNOWN, independent of source order.
// This is a projection, not the whole register schema: other metadata is opaque;
// statusAsOf is carried for the r1 presence check, aging validation belongs to r2.
// Backlog: own '# ' title and own '\u0421\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435: VALUE[: detail]' lines; VALUE is
// OPEN|PARTIAL|CLOSED|WITHDRAWN|UNKNOWN|\u041e\u0422\u041a\u0420\u042b\u0422\u041e|\u0427\u0410\u0421\u0422\u0418\u0427\u041d\u041e|\u041f\u041e\u0421\u0410\u0416\u0415\u041d\u041e|\u0412 \u0420\u0410\u0411\u041e\u0422\u0415|
// \u041f\u0415\u0420\u0415\u041d\u0415\u0421\u0415\u041d\u041e. The two legacy '\u041f\u041e\u0421\u0410\u0416\u0415\u041d\u041e \u0432 \u0447\u0430\u0441\u0442\u0438 \u044f\u0434\u0440\u0430'/'\u041f\u0415\u0420\u0415\u041d\u0415\u0421\u0415\u041d\u041e \u0432 X.Y.Z
// (\u043f\u0443\u043d\u043a\u0442 N.N).' forms are explicit. Any other value is UNKNOWN.
// Questions: exactly one own '## Open questions'; up to ten nonblank own plain
// or list-item lines until the next own heading. Inline code/links are data.
// Fences, quotes, tables, comments, HTML, indented code and front matter are
// masked before matching. Missing/duplicate sections are UNKNOWN, never first.
// Confusables in the structural keys never match; free prose is Unicode data.
// Schedule cells: id [a-z][a-z0-9-]{0,63}, status exactly
// dry|manual|failed|registered|removed; absent/typed/other cells are UNKNOWN.
const textSafe = require('../../lib/text-safe.cjs');
const refuse = code => { throw Object.assign(new Error(code), { code }); };
function text(value) {
  const policy = { crlf: 'normalise', invisible: 'refuse' };
  const decoded = typeof value === 'string' ? textSafe.decodeText(value, policy) : textSafe.decode(value, policy);
  if (!decoded.ok) refuse(`PULSE-TEXT-${decoded.problems[0].code}`);
  if (decoded.text.normalize('NFC') !== decoded.text || [...decoded.text].some(textSafe.isIgnorableFormat)) refuse('PULSE-TEXT-NONCANONICAL');
  return decoded.text;
}
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const STATUS = Object.freeze(['open', 'partial', 'unknown', 'closed', 'withdrawn']);
function register(value) {
  const data = textSafe.parseJsonUnique(text(value));
  if (!data || !Array.isArray(data.items)) refuse('PULSE-REGISTER-SHAPE');
  const items = new Map();
  for (const item of data.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.id !== 'string' || !/^OR-[0-9]{4}$/.test(item.id)) refuse('PULSE-REGISTER-SHAPE');
    const row = { id: item.id, status: STATUS.includes(item.status) ? item.status : 'UNKNOWN', statusAsOf: item.statusAsOf };
    const previous = items.get(row.id);
    if (previous && (previous.status !== row.status || previous.statusAsOf !== row.statusAsOf)) {
      row.status = 'UNKNOWN'; row.statusAsOf = undefined;
    }
    items.set(row.id, row);
  }
  return [...items.values()];
}
const own = (line, kinds) => line.kinds.every(kind => kinds.includes(kind));
function backlog(value) {
  const lines = textSafe.maskMarkdown(text(value)).lines;
  if (!lines.some(l => own(l, ['heading']) && /^# /.test(l.text))) refuse('PULSE-BACKLOG-SHAPE');
  return lines.filter(l => own(l, []) && /^ {0,3}\u0421\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435:/.test(l.text)).map(l => {
    const raw = l.text.replace(/^ {0,3}\u0421\u043e\u0441\u0442\u043e\u044f\u043d\u0438\u0435: */, '');
    const token = /^(OPEN|PARTIAL|CLOSED|WITHDRAWN|UNKNOWN|\u041e\u0422\u041a\u0420\u042b\u0422\u041e|\u0427\u0410\u0421\u0422\u0418\u0427\u041d\u041e|\u041f\u041e\u0421\u0410\u0416\u0415\u041d\u041e|\u0412 \u0420\u0410\u0411\u041e\u0422\u0415|\u041f\u0415\u0420\u0415\u041d\u0415\u0421\u0415\u041d\u041e)(?=:|$)/.exec(raw)?.[1];
    if (token) return token;
    if (/^\u041f\u041e\u0421\u0410\u0416\u0415\u041d\u041e \u0432 \u0447\u0430\u0441\u0442\u0438 \u044f\u0434\u0440\u0430: /.test(raw)) return '\u041f\u041e\u0421\u0410\u0416\u0415\u041d\u041e';
    if (/^\u041f\u0415\u0420\u0415\u041d\u0415\u0421\u0415\u041d\u041e \u0432 [0-9]+\.[0-9]+\.[0-9]+ \(\u043f\u0443\u043d\u043a\u0442 [0-9]+\.[0-9]+\)\.$/.test(raw)) return '\u041f\u0415\u0420\u0415\u041d\u0415\u0421\u0415\u041d\u041e';
    return 'UNKNOWN';
  });
}
function questions(value) {
  const lines = textSafe.maskMarkdown(text(value)).lines;
  const heads = lines.flatMap((l, i) => own(l, ['heading']) && l.text === '## Open questions' ? [i] : []);
  if (heads.length !== 1) return ['UNKNOWN: Open questions section missing or duplicated'];
  const out = [];
  for (const line of lines.slice(heads[0] + 1)) {
    if (own(line, ['heading', 'setext-heading']) && line.kinds.some(k => k.endsWith('heading'))) break;
    if (own(line, ['list-item', 'code-span', 'inline-link']) && line.text.trim()) out.push(line.text.replace(/^[- ]+/, ''));
    if (out.length === 10) break;
  }
  return out;
}
// Suite timing history (.ai/runtime/test-timing.jsonl, one line per full run, written by
// the driver): the LAST line is the last full suite run. Per-file durations are its files
// map; per-file start offsets (finding 11.99) its starts map.
// A truncated JSON line is ignored; a readable last record with a bad shape refuses
// rather than silently presenting an older run as the last one.
function timingFile(name, seconds, startMs) {
  return { name, seconds: Number.isFinite(seconds) && seconds >= 0 ? seconds : null,
    startMs: Number.isSafeInteger(startMs) && startMs >= 0 ? startMs : null };
}
function suiteTiming(value) {
  const lines = text(value).split(/\r?\n/);
  let chosen = null;
  let chosenLine = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    let entry;
    try { entry = JSON.parse(lines[index]); } catch { continue; }
    chosen = entry;
    chosenLine = index + 1;
  }
  if (!plain(chosen) || !plain(chosen.files) || typeof chosen.ts !== 'string' ||
      !Number.isFinite(Date.parse(chosen.ts))) refuse('PULSE-TIMING-SHAPE');
  chosen = textSafe.parseJsonUnique(lines[chosenLine - 1]);
  const starts = plain(chosen.starts) && !Array.isArray(chosen.starts) ? chosen.starts : {};
  const rows = Object.entries(chosen.files).map(([name, seconds]) => timingFile(name, seconds, starts[name]));
  if (!rows.length || rows.some(row => !row.name.trim())) refuse('PULSE-TIMING-SHAPE');
  return {
    line: chosenLine,
    at: chosen.ts,
    runId: typeof chosen.runId === 'string' && chosen.runId ? chosen.runId : 'unknown',
    conc: Number.isFinite(Number(chosen.conc)) ? String(chosen.conc) : 'unknown',
    rows,
  };
}
// Locate actual timing.files keys in the same decoded JSON used for the values.
// Token paths distinguish nested decoys and quoted/escaped strings from properties;
// unique-key parsing refuses ambiguous evidence. Compact JSON naturally cites line 1.
function receiptTiming(value) {
  const source = text(value);
  const data = textSafe.parseJsonUnique(source);
  const files = plain(data?.timing) && plain(data.timing.files) ? data.timing.files : null;
  if (!files) return { files: null, lines: {} };
  const tokens = /"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g;
  let token, end = 0, line = 1;
  const next = () => {
    const match = tokens.exec(source);
    if (!match) { token = null; return; }
    line += source.slice(end, match.index).split('\n').length - 1;
    token = { text: match[0], line };
    line += match[0].split('\n').length - 1;
    end = tokens.lastIndex;
  };
  const lines = {};
  const walk = keys => {
    const open = token.text;
    next();
    if (open !== '{' && open !== '[') return;
    const close = open === '{' ? '}' : ']';
    while (token.text !== close) {
      let child = keys;
      if (open === '{') {
        const key = JSON.parse(token.text);
        if (keys.length === 2 && keys[0] === 'timing' && keys[1] === 'files')
          Object.defineProperty(lines, key, { value: token.line, enumerable: true });
        child = [...keys, key];
        next(); next(); // colon, value
      } else child = [...keys, null];
      walk(child);
      if (token.text === ',') next();
    }
    next();
  };
  next(); walk([]);
  return { files, lines };
}
function scheduleTask(task) {
  return {
    id: typeof task?.id === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(task.id) ? task.id : 'UNKNOWN',
    status: ['dry', 'manual', 'failed', 'registered', 'removed'].includes(task?.status) ? task.status : 'UNKNOWN',
  };
}
// ASSIGN-EXECUTION R1: the owner's mode file (assignment-mode/1) and the machine state file (assign-state/1), as one display line. This is
// a projection for the operator, not the launch decision (the assign state module of the development line decides); it needs no such module because this file is installed
// in every project. A file that does not read is shown as UNREADABLE, never as a quiet off.
const ASSIGN_WARN_HOURS = 48; // the same value as expiry.warnHours of the assign execution policy
const stampOk = s => typeof s === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}.[0-9]{3}Z$/.test(s) && Number.isFinite(Date.parse(s));
const strictJson = value => textSafe.parseJsonUnique(String(text(value)));
function assignMode(value) {
  const data = strictJson(value);
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.schema !== 'assignment-mode/1' || !['off', 'advise', 'assign'].includes(data.mode)
    || !stampOk(data.expiresAt) || !Array.isArray(data.assignClasses) || data.assignClasses.length > 200 || !data.assignClasses.every(c => typeof c === 'string')) refuse('PULSE-ASSIGN-MODE-SHAPE');
  return { mode: data.mode, classes: data.assignClasses.slice(), expiresAt: data.expiresAt };
}
function assignState(value) {
  const data = strictJson(value);
  const plain = v => v && typeof v === 'object' && !Array.isArray(v);
  if (!plain(data) || data.schema !== 'assign-state/1' || !(data.hold === null || plain(data.hold)) || !plain(data.demoted) || !plain(data.quarantinedRoutes)) refuse('PULSE-ASSIGN-STATE-SHAPE');
  return { hold: data.hold !== null, demoted: Object.keys(data.demoted), quarantined: Object.values(data.quarantinedRoutes).map(q => (plain(q) ? q.until : null)) };
}
function assignLine(assign, nowMs) {
  const mode = assign && assign.mode;
  if (!mode) return 'ASSIGN mode=off declared=no classes=0 demoted=0 hold=no quarantined=0 assigned=n/a';
  if (mode.invalid) return 'ASSIGN mode=UNREADABLE (the mode file does not read; a launch reads it as off)';
  const left = Date.parse(mode.expiresAt) - nowMs;
  const expired = left <= 0;
  const state = assign.state;
  const needed = mode.mode === 'assign' && mode.classes.length > 0 && !expired;
  const stateText = state === null || state === undefined ? (needed ? 'ABSENT (every class is advise until the state file is created)' : 'none')
    : state.invalid ? 'INVALID (every class is demoted)' : 'ok';
  const demoted = state && !state.invalid ? state.demoted.length : 0;
  const quarantined = state && !state.invalid ? state.quarantined.filter(u => stampOk(u) && Date.parse(u) > nowMs).length : 0;
  const hold = state && !state.invalid && state.hold ? 'yes' : 'no';
  const expiry = expired ? `EXPIRED ${Math.floor(-left / 3600000)}h ago (a launch reads it as off)`
    : `${mode.expiresAt}${left <= ASSIGN_WARN_HOURS * 3600000 ? ` WARN expires in ${Math.floor(left / 3600000)}h` : ''}`;
  return `ASSIGN mode=${mode.mode} classes=${mode.classes.length} demoted=${demoted} hold=${hold} quarantined=${quarantined} state=${stateText} expires=${expiry} assigned=n/a`;
}
module.exports = { text, register, backlog, questions, timingFile, receiptTiming, scheduleTiming: suiteTiming, scheduleTask, assignMode, assignState, assignLine };
