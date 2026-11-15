'use strict';
// approve-config: readers and byte-preserving editors of the auto-approval keys of the client configs (AUTO-APPROVE).
// Three formats, each handled by the smallest reader that can refuse what it does not understand:
//   json / jsonc  a span parser: every value keeps its byte offsets, an edit replaces one value span or inserts one member; comments and
//                 every other byte survive. Duplicate keys, an unterminated string or comment, or trailing text refuse (json also refuses comments
//                 and trailing commas).
//   toml          a conservative line scanner: blank, comment, [table], [[array table]] and key = value lines (values may span lines: arrays,
//                 inline tables, multi-line strings). A repeated [table] header, a repeated key in one table or a line of any other shape refuses.
//                 An edit replaces one single-line value, inserts one key line, or appends one new [table]; a table is never written twice, and a
//                 target table that is also reachable through a dotted key or an inline table refuses (two spellings of one table).
//   ps-profile    one wrapper function per client anywhere in the profile; a missing one goes into a marked block (# auto-approve:start ... :end),
//                 the only place ever inserted into.
// Nothing here reads the user profile on its own: every caller passes the text it read. Values printed by callers come from safeValue only,
// and a string is printed only when it is an exact word of the closed vocabulary of its key (vocabulary); every other value prints its kind.
const BLOCK_START = '# auto-approve:start';
const BLOCK_END = '# auto-approve:end';

class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'CONFIG_PARSE'; }
}
const fail = msg => { throw new ConfigError(msg); };
const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');

// The bytes of a config: a UTF-8 byte order mark is kept apart (and written back), invalid UTF-8 refuses.
function decode(buf) {
  let text;
  // ignoreBOM keeps the mark in the decoded text (the default decoder drops it silently, and the write would lose it)
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf); } catch { fail('the file is not valid UTF-8'); }
  const bom = text.charCodeAt(0) === 0xfeff;
  return { bom, text: bom ? text.slice(1) : text };
}
const encode = (bom, text) => Buffer.from((bom ? String.fromCharCode(0xfeff) : '') + text, 'utf8');

// The closed approval vocabulary per key: the documented values of each measured key (by its dotted name and format). The wanted value of the
// key and, for a profile wrapper, its flag and pass-through flags are added by vocabulary(); nothing else is ever printed.
const VOCABULARY = [
  { format: 'json', name: /^permissions\.defaultMode$/, words: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'] },
  { format: 'jsonc', name: /^permission\.[a-z_]+$/, words: ['allow', 'ask', 'deny'] },
  { format: 'toml', name: /^approval_policy$/, words: ['untrusted', 'on-failure', 'on-request', 'never'] },
  { format: 'toml', name: /^sandbox_mode$/, words: ['read-only', 'workspace-write', 'danger-full-access'] },
  { format: 'toml', name: /^tools\.[a-z_]+\.permission$/, words: ['always', 'ask', 'never'] },
];
function vocabulary(spec, key) {
  const name = spec.format === 'toml' ? tomlKeyFull(key).join('.') : spec.format === 'ps-profile' ? null : key.path.join('.');
  const words = new Set(VOCABULARY.filter(v => v.format === spec.format && name !== null && v.name.test(name)).flatMap(v => v.words));
  for (const w of spec.format === 'ps-profile' ? [key.flag, ...(key.passThrough || [])] : [key.value]) if (typeof w === 'string') words.add(w);
  return words;
}

// A value safe to print: a boolean, or a string that is an exact member of words (the key's closed vocabulary); anything else is named by its
// kind only (never echoed), so a token stored in an approval key never leaves the tool whatever its shape.
function safeValue(v, words) {
  if (v === undefined) return '(absent)';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string' && words instanceof Set && words.has(v)) return JSON.stringify(v);
  if (v && typeof v === 'object' && !Array.isArray(v)) return '(object)';
  return `(other ${Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v})`;
}

// ---------------------------------------------------------------- json / jsonc
function parseJson(text, { comments }) {
  let i = 0;
  const skip = () => {
    for (;;) {
      while (i < text.length && /[ \t\r\n]/.test(text[i])) i++;
      if (text[i] === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
        if (!comments) fail(`a comment at offset ${i} (strict JSON)`);
        if (text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; }
        else { const e = text.indexOf('*/', i + 2); if (e < 0) fail('an unterminated block comment'); i = e + 2; }
      } else return;
    }
  };
  const str = () => {
    const s = i; i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; else if (text[i] === '\n') fail(`a line break inside a string at offset ${s}`); i++; }
    if (i >= text.length) fail(`an unterminated string at offset ${s}`);
    i++;
    let value; try { value = JSON.parse(text.slice(s, i)); } catch { fail(`a bad string at offset ${s}`); }
    return { type: 'string', start: s, end: i, value };
  };
  const value = () => {
    skip();
    const c = text[i];
    if (c === '{') {
      const node = { type: 'object', start: i, members: [] }; i++;
      const seen = new Set();
      for (;;) {
        skip();
        if (text[i] === '}') { node.end = ++i; return node; }
        if (node.members.length && !node.comma) fail(`a missing comma at offset ${i}`);
        if (text[i] !== '"') fail(`a key expected at offset ${i}`);
        const k = str();
        if (seen.has(k.value)) fail(`the key ${JSON.stringify(k.value).slice(0, 60)} is repeated in one object`);
        seen.add(k.value);
        skip(); if (text[i] !== ':') fail(`a colon expected at offset ${i}`); i++;
        const v = value();
        node.members.push({ key: k.value, keyStart: k.start, value: v });
        skip(); node.comma = false;
        if (text[i] === ',') {
          node.comma = true; i++; skip();
          if (text[i] === '}' && !comments) fail(`a trailing comma at offset ${i} (strict JSON)`);
        } else if (text[i] !== '}') fail(`a comma or a closing brace expected at offset ${i}`);
      }
    }
    if (c === '[') {
      const node = { type: 'array', start: i, items: [] }; i++;
      for (;;) {
        skip();
        if (text[i] === ']') { node.end = ++i; return node; }
        if (node.items.length && !node.comma) fail(`a missing comma at offset ${i}`);
        node.items.push(value()); skip(); node.comma = false;
        if (text[i] === ',') {
          node.comma = true; i++; skip();
          if (text[i] === ']' && !comments) fail(`a trailing comma at offset ${i} (strict JSON)`);
        } else if (text[i] !== ']') fail(`a comma or a closing bracket expected at offset ${i}`);
      }
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 400));
    if (!m) fail(`a value expected at offset ${i}`);
    const s = i; i += m[0].length;
    return { type: m[0] === 'null' ? 'null' : (m[0] === 'true' || m[0] === 'false') ? 'boolean' : 'number', start: s, end: i, value: JSON.parse(m[0]) };
  };
  const root = value();
  skip();
  if (i !== text.length) fail(`trailing text at offset ${i}`);
  if (root.type !== 'object') fail('the top level is not an object');
  return root;
}

const plain = node => {
  if (!node) return undefined;
  if (node.type === 'object') return Object.fromEntries(node.members.map(m => [m.key, plain(m.value)]));
  if (node.type === 'array') return node.items.map(plain);
  return node.value;
};
const member = (obj, key) => obj.members.find(m => m.key === key);

// The value of one key path; { found, node } (a missing parent is just not found; a parent that is not an object refuses).
function jsonGet(root, keyPath) {
  let cur = root;
  for (let k = 0; k < keyPath.length; k++) {
    if (cur.type !== 'object') fail(`${keyPath.slice(0, k).join('.')} is not an object`);
    const m = member(cur, keyPath[k]);
    if (!m) return { found: false };
    cur = m.value;
  }
  return { found: true, node: cur };
}

// A key is on when it holds the value; with wildcard an object counts when its "*" member holds the value (kilo, mimocode rule maps).
function jsonKeyState(root, key) {
  const got = jsonGet(root, key.path);
  if (!got.found) return { on: false, current: undefined };
  const v = plain(got.node);
  if (key.wildcard && got.node.type === 'object') { const star = member(got.node, '*'); return { on: !!star && plain(star.value) === key.value, current: star ? plain(star.value) : v }; }
  return { on: v === key.value, current: v };
}

function indentUnit(text) {
  const sizes = text.split(/\r?\n/).map(l => /^( +)\S/.exec(l)).filter(Boolean).map(m => m[1].length);
  const tab = text.split(/\r?\n/).some(l => /^\t+\S/.test(l));
  if (tab && !sizes.length) return '\t';
  return ' '.repeat(sizes.length ? Math.min(...sizes) : 2);
}
const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const lineIndent = (text, pos) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0];

function render(value, indent, unit, eol) {
  return JSON.stringify(value, null, unit).split('\n').join(eol + indent);
}

// Insert one member into an object node; every existing byte stays where it was (only the inserted text and, when needed, one comma are new).
function insertMember(text, obj, key, value) {
  const eol = eolOf(text); const unit = indentUnit(text);
  if (obj.members.length) {
    const last = obj.members[obj.members.length - 1];
    const indent = lineIndent(text, last.keyStart);
    const entry = `${JSON.stringify(key)}: ${render(value, indent, unit, eol)}`;
    // a trailing comma already there (jsonc): the new member goes after it and keeps the trailing style
    let j = last.value.end; while (/[ \t]/.test(text[j])) j++;
    if (text[j] === ',') {
      const nl = text.indexOf('\n', j); const at = nl < 0 || nl > obj.end ? j + 1 : nl + 1;
      return at === j + 1 ? text.slice(0, at) + eol + indent + entry + ',' + text.slice(at) : text.slice(0, at) + indent + entry + ',' + eol + text.slice(at);
    }
    // no comma: one comma right after the last value; the member goes after the rest of that line when the rest is blank or a line comment
    const at = last.value.end;
    const rest = /^[ \t]*(\/\/[^\n]*)?(?=\r?\n)/.exec(text.slice(at));
    if (rest) { const nl = at + rest[0].length + (text[at + rest[0].length] === '\r' ? 2 : 1); return text.slice(0, at) + ',' + text.slice(at, nl) + indent + entry + eol + text.slice(nl); }
    return text.slice(0, at) + ',' + eol + indent + entry + text.slice(at);
  }
  const outer = lineIndent(text, obj.start); const inner = outer + unit;
  const entry = `${JSON.stringify(key)}: ${render(value, inner, unit, eol)}`;
  const inside = text.slice(obj.start + 1, obj.end - 1);
  if (/\n/.test(inside)) return text.slice(0, obj.start + 1) + eol + inner + entry + text.slice(obj.start + 1);
  return text.slice(0, obj.start + 1) + eol + inner + entry + eol + outer + text.slice(obj.end - 1);
}

const nest = (rest, value) => rest.reduceRight((acc, k) => ({ [k]: acc }), value);

function jsonSet(text, key, comments) {
  const root = parseJson(text, { comments });
  let cur = root;
  for (let k = 0; k < key.path.length; k++) {
    if (cur.type !== 'object') fail(`${key.path.slice(0, k).join('.')} is not an object`);
    const m = member(cur, key.path[k]);
    const lastSeg = k === key.path.length - 1;
    if (!m) return insertMember(text, cur, key.path[k], lastSeg ? key.value : nest(key.path.slice(k + 1), key.value));
    if (lastSeg) {
      if (key.wildcard && m.value.type === 'object') {
        const star = member(m.value, '*');
        if (!star) return insertMember(text, m.value, '*', key.value);
        return text.slice(0, star.value.start) + JSON.stringify(key.value) + text.slice(star.value.end);
      }
      return text.slice(0, m.value.start) + JSON.stringify(key.value) + text.slice(m.value.end);
    }
    cur = m.value;
  }
  return text;
}

// ---------------------------------------------------------------- toml
const BARE = /^[A-Za-z0-9_-]+/;
// One dotted key (bare, "basic" or 'literal' segments); returns { segments, rest } or null.
function readKey(s) {
  const segments = []; let i = 0;
  for (;;) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    let m;
    if (s[i] === '"') { const e = /^"(?:[^"\\\n]|\\.)*"/.exec(s.slice(i)); if (!e) return null; try { segments.push(JSON.parse(e[0])); } catch { return null; } i += e[0].length; }
    else if (s[i] === "'") { const e = /^'[^'\n]*'/.exec(s.slice(i)); if (!e) return null; segments.push(e[0].slice(1, -1)); i += e[0].length; }
    else if ((m = BARE.exec(s.slice(i)))) { segments.push(m[0]); i += m[0].length; }
    else return null;
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] !== '.') return { segments, rest: s.slice(i) };
    i++;
  }
}

// Scan one value from position i of text; returns the end offset (exclusive, before any trailing comment) or fails.
function scanValue(text, i) {
  const start = i; let depth = 0;
  for (;;) {
    if (i >= text.length) { if (depth) fail(`an unterminated array or inline table starting at offset ${start}`); return i; }
    const c = text[i];
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      const q = text.slice(i, i + 3); let e = text.indexOf(q, i + 3);
      while (e >= 0 && q === '"""' && text[e - 1] === '\\' && text[e - 2] !== '\\') e = text.indexOf(q, e + 1);
      if (e < 0) fail(`an unterminated multi-line string at offset ${i}`);
      i = e + 3; while (text[i] === q[0]) i++; continue;
    }
    if (c === '"') { const e = /^"(?:[^"\\\r\n]|\\.)*"/.exec(text.slice(i)); if (!e) fail(`an unterminated string at offset ${i}`); i += e[0].length; continue; }
    if (c === "'") { const e = /^'[^'\r\n]*'/.exec(text.slice(i)); if (!e) fail(`an unterminated string at offset ${i}`); i += e[0].length; continue; }
    if (c === '[' || c === '{') { depth++; i++; continue; }
    if (c === ']' || c === '}') { depth--; if (depth < 0) fail(`an unbalanced bracket at offset ${i}`); i++; continue; }
    if (c === '#') { const nl = text.indexOf('\n', i); if (!depth) return i; i = nl < 0 ? text.length : nl; continue; }
    if (c === '\n' && !depth) return i;
    i++;
  }
}

function tomlScalar(raw) {
  const s = raw.trim();
  if (s === 'true' || s === 'false') return { simple: true, value: s === 'true' };
  if (/^"(?:[^"\\]|\\.)*"$/.test(s)) { try { return { simple: true, value: JSON.parse(s) }; } catch { return { simple: false }; } }
  if (/^'[^']*'$/.test(s)) return { simple: true, value: s.slice(1, -1) };
  if (/^[+-]?\d+(\.\d+)?$/.test(s)) return { simple: true, value: Number(s) };
  return { simple: false };
}

const tkey = segs => segs.join('\u0000');

// The structure of a TOML text: tables (name -> header line), key lines with their table and value spans, and the first header offset.
function scanToml(text) {
  // arrays: name of an array of tables -> its element count; every [[name]] header opens a new element, and a [name.sub] header after it
  // belongs to that element (its keys are scoped by the element index, so two elements may repeat a key)
  const tables = new Map(); const keys = []; const arrays = new Map();
  const scoped = segs => {
    for (let n = segs.length - 1; n > 0; n--) {
      const prefix = tkey(segs.slice(0, n));
      if (arrays.has(prefix)) return [...segs.slice(0, n), `[${arrays.get(prefix) - 1}]`, ...segs.slice(n)];
    }
    return segs;
  };
  let table = []; let i = 0; let firstHeader = -1;
  const seenKeys = new Set();
  while (i < text.length) {
    const nl = text.indexOf('\n', i); const lineEnd = nl < 0 ? text.length : nl;
    const line = text.slice(i, lineEnd).replace(/\r$/, '');
    const t = line.trim();
    if (!t || t.startsWith('#')) { i = lineEnd + 1; continue; }
    if (t.startsWith('[')) {
      const array = t.startsWith('[[');
      const k = readKey(t.slice(array ? 2 : 1));
      const close = array ? ']]' : ']';
      if (!k || !k.rest.startsWith(close) || !/^\s*(#.*)?$/.test(k.rest.slice(close.length))) fail(`a bad table header on the line at offset ${i}`);
      const segs = scoped(k.segments);
      const name = tkey(segs);
      if (array) { if (tables.has(name)) fail(`[[${k.segments.join('.')}]] is also a plain table`); arrays.set(name, (arrays.get(name) || 0) + 1); }
      else { if (tables.has(name) || arrays.has(name)) fail(`the table [${k.segments.join('.')}] is defined twice`); tables.set(name, { segments: k.segments, start: i, lineEnd, keys: [] }); }
      if (firstHeader < 0) firstHeader = i;
      table = array ? [...segs, `[${arrays.get(name) - 1}]`] : segs;
      i = lineEnd + 1; continue;
    }
    const k = readKey(line);
    if (!k || !k.rest.startsWith('=')) fail(`a line that is not a key, a table or a comment at offset ${i}`);
    let vs = i + (line.length - k.rest.length) + 1;
    while (text[vs] === ' ' || text[vs] === '\t') vs++;
    if (vs >= lineEnd) fail(`a key without a value at offset ${i}`);
    let ve = scanValue(text, vs);
    let after = ve; const end = text.indexOf('\n', after);
    const tail = text.slice(after, end < 0 ? text.length : end).replace(/\r$/, '');
    if (!/^\s*(#.*)?$/.test(tail)) fail(`trailing text after a value at offset ${after}`);
    while (ve > vs && /[ \t\r]/.test(text[ve - 1])) ve--;
    // a key followed only by a comment (approval_policy = # x) has no value: a parse refusal, never a write at the offset of the comment
    if (ve === vs) fail(`a key without a value at offset ${i}`);
    const full = tkey([...table, ...k.segments]);
    if (seenKeys.has(full)) fail(`the key ${[...table, ...k.segments].join('.')} is defined twice`);
    seenKeys.add(full);
    const raw = text.slice(vs, ve);
    const entry = { table: tkey(table), segments: k.segments, full: [...table, ...k.segments], lineStart: i, valueStart: vs, valueEnd: ve, multiline: /\n/.test(raw), inline: /^[[{]/.test(raw), scalar: tomlScalar(raw) };
    keys.push(entry);
    if (tables.has(tkey(table))) tables.get(tkey(table)).keys.push(entry);
    i = (end < 0 ? text.length : end) + 1;
  }
  return { tables, keys, arrays, firstHeader };
}

const tomlKeyFull = key => [...(key.table || []), key.key];

function tomlKeyState(scan, key) {
  const full = tkey(tomlKeyFull(key));
  const e = scan.keys.find(x => tkey(x.full) === full);
  if (!e) return { on: false, current: undefined };
  return { on: e.scalar.simple && e.scalar.value === key.value, current: e.scalar.simple ? e.scalar.value : { complex: true } };
}

const renderSeg = s => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s));
const tomlValue = v => {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string' && /^[\x20-\x7e]*$/.test(v)) return JSON.stringify(v);
  fail('only a boolean or a printable ASCII string can be written');
};

function tomlSet(text, key) {
  const scan = scanToml(text);
  const eol = eolOf(text);
  const tableSegs = key.table || [];
  const full = tomlKeyFull(key);
  const name = tkey(tableSegs);
  // the table must have ONE spelling: a key elsewhere whose path reaches into the target table (a dotted key, an inline table) refuses
  if (tableSegs.length) {
    if ([...scan.arrays.keys()].some(a => name === a || name.startsWith(a + '\u0000'))) fail(`[${tableSegs.join('.')}] is inside an array of tables`);
    for (const e of scan.keys) {
      const reaches = e.full.length <= full.length ? tkey(full).startsWith(tkey(e.full)) : false;
      const insideOther = e.table !== name && !e.table.startsWith(name + '\u0000') && tkey(e.full).startsWith(name + '\u0000');
      if ((reaches && tkey(e.full) !== tkey(full)) || insideOther) fail(`[${tableSegs.join('.')}] is also written through the key ${e.full.join('.')}; edit it by hand`);
    }
  }
  const existing = scan.keys.find(x => tkey(x.full) === tkey(full));
  if (existing) {
    if (existing.table !== name) fail(`${full.join('.')} is written as a dotted key outside its table; edit it by hand`);
    if (existing.multiline || existing.inline) fail(`${full.join('.')} holds a multi-line or inline value; edit it by hand`);
    return text.slice(0, existing.valueStart) + tomlValue(key.value) + text.slice(existing.valueEnd);
  }
  const lineText = `${renderSeg(key.key)} = ${tomlValue(key.value)}`;
  if (!tableSegs.length) {
    if (scan.firstHeader < 0) return text + (text && !text.endsWith('\n') ? eol : '') + lineText + eol;
    // before the first header, above the blank lines that separate it
    let at = scan.firstHeader;
    for (;;) { const prev = text.lastIndexOf('\n', at - 2); const l = text.slice(prev + 1, at); if (at > 0 && /^\s*$/.test(l)) at = prev + 1; else break; }
    return text.slice(0, at) + lineText + eol + text.slice(at);
  }
  const t = scan.tables.get(name);
  if (t) { const at = t.lineEnd + 1; return text.slice(0, at) + (t.lineEnd >= text.length ? eol : '') + lineText + eol + text.slice(at); }
  const header = `[${tableSegs.map(renderSeg).join('.')}]`;
  return text + (text && !text.endsWith('\n') ? eol : '') + (text ? eol : '') + header + eol + lineText + eol;
}

// ---------------------------------------------------------------- ps-profile
function profileBlock(text) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const starts = lines.map((l, i) => (l.trim() === BLOCK_START ? i : -1)).filter(i => i >= 0);
  const ends = lines.map((l, i) => (l.trim() === BLOCK_END ? i : -1)).filter(i => i >= 0);
  if (!starts.length && !ends.length) return null;
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) fail('the auto-approve block markers are repeated or out of order');
  return { start: starts[0], end: ends[0], lines };
}
const fnRe = name => new RegExp(`^function\\s+${name.replace(/[^A-Za-z0-9_-]/g, '')}\\s*\\{`, 'i');

// The wrapper function of a client anywhere in the profile (a wrapper written by hand under another marker counts the same); it runs to its
// closing brace at the start of a line. Two definitions of one name are ambiguous and refuse.
function profileFunction(text, name) {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
  const hits = lines.map((l, i) => (fnRe(name).test(l.trim()) ? i : -1)).filter(i => i >= 0);
  if (!hits.length) return null;
  if (hits.length > 1) fail(`the wrapper function ${name} is defined more than once`);
  let stop = lines.findIndex((l, i) => i > hits[0] && l === '}');
  if (stop < 0) stop = lines.length - 1;
  return lines.slice(hits[0], stop + 1).join('\n');
}

function profileKeyState(text, key) {
  profileBlock(text);
  const fn = profileFunction(text, key.function);
  if (!fn) return { on: false, current: undefined };
  const flag = /-Flag\s+'([^']*)'/.exec(fn);
  return { on: !!flag && flag[1] === key.flag, current: flag ? flag[1] : undefined };
}

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`;
const HELPER = [
  'function Invoke-AutoApproveCli {',
  '    param([string]$Exe, [string]$Flag, [string[]]$PassThrough, [object[]]$Rest)',
  '    $plain = $true',
  '    foreach ($a in $Rest) { if ($PassThrough -contains "$a") { $plain = $false } }',
  '    if ($plain) { & $Exe $Flag @Rest } else { & $Exe @Rest }',
  '}',
];
function wrapperLines(key) {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key.function)) fail('a wrapper function name must be a plain word');
  return [
    `function ${key.function} {`,
    `    Invoke-AutoApproveCli -Exe "${key.exe}" -Flag ${psQuote(key.flag)} \``,
    `        -PassThrough @(${key.passThrough.map(psQuote).join(', ')}) -Rest $args`,
    '}',
  ];
}

function profileSet(text, key) {
  const eol = eolOf(text);
  const fnLines = wrapperLines(key);
  if (fnLines.some(l => /[^\x20-\x7e]/.test(l))) fail('a profile wrapper must be ASCII only');
  if (profileFunction(text, key.function)) fail(`the wrapper function ${key.function} exists with another flag; edit it by hand`);
  const helper = profileFunction(text, 'Invoke-AutoApproveCli') !== null;
  const block = profileBlock(text);
  if (!block) {
    const add = [BLOCK_START, '# Interactive agent CLIs start in auto-approve mode; an explicit mode, a one-shot prompt or an info flag passes through unchanged.', ...(helper ? [] : HELPER), ...fnLines, BLOCK_END];
    return text + (text && !text.endsWith('\n') ? eol : '') + add.join(eol) + eol;
  }
  // insert before the end marker line: find its byte offset
  let off = 0; for (let n = 0; n < block.end; n++) off = text.indexOf('\n', off) + 1;
  return text.slice(0, off) + [...(helper ? [] : HELPER), ...fnLines].join(eol) + eol + text.slice(off);
}

// ---------------------------------------------------------------- one interface over the formats
// state(text, spec) -> { keys: [{ name, on, current, want, words }] } (words: the closed vocabulary of the key, for safeValue);
// set(text, spec) -> new text (every key of spec on). Both refuse on a parse error.
function keyName(spec, key) {
  if (spec.format === 'toml') return tomlKeyFull(key).join('.');
  if (spec.format === 'ps-profile') return `function ${key.function} -Flag ${key.flag}`;
  return key.path.join('.') + (key.wildcard ? ' (or its "*" member)' : '');
}

function state(text, spec) {
  if (spec.format === 'json' || spec.format === 'jsonc') {
    const root = parseJson(text, { comments: spec.format === 'jsonc' });
    return { keys: spec.keys.map(k => ({ name: keyName(spec, k), want: k.value, words: vocabulary(spec, k), ...jsonKeyState(root, k) })) };
  }
  if (spec.format === 'toml') { const scan = scanToml(text); return { keys: spec.keys.map(k => ({ name: keyName(spec, k), want: k.value, words: vocabulary(spec, k), ...tomlKeyState(scan, k) })) }; }
  if (spec.format === 'ps-profile') { profileBlock(text); return { keys: spec.keys.map(k => ({ name: keyName(spec, k), want: k.flag, words: vocabulary(spec, k), ...profileKeyState(text, k) })) }; }
  fail(`unknown config format ${spec.format}`);
}

function set(text, spec) {
  let out = text;
  for (const k of spec.keys) {
    const before = state(out, { ...spec, keys: [k] }).keys[0];
    if (before.on) continue;
    if (spec.format === 'json' || spec.format === 'jsonc') out = jsonSet(out, k, spec.format === 'jsonc');
    else if (spec.format === 'toml') out = tomlSet(out, k);
    else if (spec.format === 'ps-profile') out = profileSet(out, k);
    else fail(`unknown config format ${spec.format}`);
  }
  const after = state(out, spec);
  if (!after.keys.every(k => k.on)) fail('the edit did not turn every key on (refused, nothing written)');
  return out;
}

module.exports = { ConfigError, BLOCK_START, BLOCK_END, VOCABULARY, decode, encode, vocabulary, safeValue, parseJson, jsonGet, scanToml, profileBlock, state, set, keyName };
