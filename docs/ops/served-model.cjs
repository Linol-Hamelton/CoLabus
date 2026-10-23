const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCES = ['agent-result', 'client-banner', 'client-log', 'launcher-model', 'none'];
const CONFIDENCE = ['exact', 'derived', 'none'];
const WINDOW_SLACK_MS = 15000;
// A served model id is accepted only by a CLOSED GRAMMAR: one to 120 printable ASCII word characters (letters, digits and
// . : + / @ # ~ _ -), starting with a letter or a digit, with no space, no control character and no invisible or format character (the Unicode Cf
// class: a zero-width space, a word joiner, a bidi override and their kin) anywhere in it. /^\S+$/ accepted them inside an id, so a value that
// renders like another id could be proven. The one grammar is the gate of every point a served model id is accepted: the agy flag value, a codex
// header model field, a dahl AGENT_RESULT model field, a vibe active_model alias.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+/@#~-]{0,119}$/;
// A placeholder value never equals an identifier and never proves: unknown, none, null, empty and "-"
// name the ABSENCE of a model (whatever the casing; "Unknown", "NONE" and "null" are placeholders too), and a placeholder that
// happens to fit the closed grammar must not become a proven model id at any acceptance point (the agy flag, a codex header
// model field, a dahl AGENT_RESULT model field, a vibe active_model alias). Any value outside the grammar refuses anyway.
const PLACEHOLDER_RE = /^(?:unknown|none|null|-)$/i;
const modelIdOf = v => (typeof v === 'string' && !PLACEHOLDER_RE.test(v) && MODEL_ID_RE.test(v) ? v : null);

// ---- vibe: names and aliases ----
// ~/.vibe/config.toml lists models by ALIAS (the value VIBE_ACTIVE_MODEL must hold) and by provider NAME. The table below is the measured one
// (config of 2026-10-10; clients.json lists only names, so it cannot give the alias). A caller with another config passes input.vibeModels
// ([{ name, alias }]); an entry given there wins. vibe-default is the model vibe falls back to when VIBE_ACTIVE_MODEL names nothing it knows.
const VIBE_MODELS = [
  { name: 'zai-glm-5-3', alias: 'glm-5-3' },
  { name: 'mistral-large-2512', alias: 'mistral-large' },
  { name: 'mistral-medium-3.5', alias: 'mistral-medium-3.5' },
  { name: 'mistral-large-4-0-3', alias: 'mistral-large-4-0-3' },
];
const lower = v => String(v || '').trim().toLowerCase();
// { known, alias, kind: 'alias'|'name'|null }: an alias stays as is, a known name is translated, anything else is not known (alias is then the input).
function vibeAlias(value, models) {
  const v = lower(value);
  const table = [...(Array.isArray(models) ? models : []), ...VIBE_MODELS].filter(m => m && m.name && m.alias);
  if (!v) return { known: false, alias: '', kind: null };
  const byAlias = table.find(m => lower(m.alias) === v);
  if (byAlias) return { known: true, alias: byAlias.alias, kind: 'alias' };
  const byName = table.find(m => lower(m.name) === v);
  if (byName) return { known: true, alias: byName.alias, kind: 'name' };
  return { known: false, alias: String(value).trim(), kind: null };
}

function norm(model) {
  return String(model || '').trim().toLowerCase().replace(/^openrouter\//, '');
}

// true when the two ids name the same model, allowing one to carry a provider prefix the other lacks
// (requested "openrouter/xiaomi/mimo-v2.6-flash", logged "xiaomi/mimo-v2.6-flash"). Anything else is false.
function modelsMatch(requested, served) {
  const a = norm(requested); const b = norm(served);
  if (!a || !b) return 'unknown';
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return false;
}

// Stream positions. A stream is read from its fixed places only: its first non-blank line(s) for a banner or a header, its last non-blank line for
// the dahl result. Nothing in the middle of a stream is looked at, whatever it says and however it is quoted.
// A stream reaches here already decoded whole by strictStream, so a BOM has already refused it (it is not stripped).
// No trim, no split on anything but the line feed. A line is BLANK only when it holds ASCII spaces and tabs:
// trim() also strips U+FEFF, NBSP and every other whitespace-like code point, so a line made of one of them looked empty and the line above it
// was read as the last one. A line made of one U+FEFF or any invisible character after the AGENT_RESULT line is a NON-EMPTY line (and an
// invisible character refuses the stream at the decode before it); a line of NBSPs is a non-empty line that is no AGENT_RESULT line: no proof.
// The split is on the line feed ONLY: the strict decode has already normalised CRLF and refused a lone CR, so no CR survives in strict text.
const blankLine = line => /^[\t ]*$/.test(line);
// The one strip of the stream and tail code - the ASCII space and tab only, never trim()
const stripBlank = s => String(s).replace(/^[\t ]+|[\t ]+$/g, '');
const headLines = text => {
  const lines = String(text || '').split('\n');
  let i = 0; while (i < lines.length && blankLine(lines[i])) i++;
  return lines.slice(i);
};
const tailLine = text => {
  const lines = String(text || '').split('\n');
  let i = lines.length - 1; while (i >= 0 && blankLine(lines[i])) i--;
  return i >= 0 ? { text: lines[i], line: i + 1 } : null;
};

// JSON with duplicate-key detection. JSON.parse keeps the LAST of two equal keys and hides the first, so one source could name two models and still prove one.
// -> { value, all(pathArray) } where all() lists EVERY value written at that path, in order (two entries = the key was written twice); throws SyntaxError.
function parseJsonAll(text) {
  const src = String(text); let i = 0; const occ = new Map();
  const fail = () => { throw new SyntaxError('not JSON'); };
  const ws = () => { while (i < src.length && ' \t\r\n'.includes(src[i])) i++; };
  const note = (p, v) => { const k = JSON.stringify(p); if (!occ.has(k)) occ.set(k, []); occ.get(k).push(v); };
  const str = () => {
    const from = i; i++;
    while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
    if (src[i] !== '"') fail();
    i++;
    return JSON.parse(src.slice(from, i));
  };
  const value = (p, depth) => {
    if (depth > 64) fail();
    ws();
    const c = src[i];
    if (c === '{') {
      i++; const obj = {}; ws();
      if (src[i] === '}') { i++; return obj; }
      for (;;) {
        ws(); if (src[i] !== '"') fail();
        const key = str(); ws(); if (src[i] !== ':') fail(); i++;
        const v = value([...p, key], depth + 1);
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        note([...p, key], v); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === '}') { i++; return obj; }
        fail();
      }
    }
    if (c === '[') {
      i++; const arr = []; ws();
      if (src[i] === ']') { i++; return arr; }
      for (;;) {
        arr.push(value([...p, arr.length], depth + 1)); ws();
        if (src[i] === ',') { i++; continue; }
        if (src[i] === ']') { i++; return arr; }
        fail();
      }
    }
    if (c === '"') return str();
    const lit = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(src.slice(i, i + 64));
    if (!lit) fail();
    i += lit[0].length;
    return JSON.parse(lit[0]);
  };
  const root = value([], 0); ws();
  if (i !== src.length) fail();
  // dups() lists every path a key was written more than once at (the object keys only; two elements
  // of one array are two paths). A record with ANY duplicated key is not one well-formed record of its schema.
  return { value: root, all: p => occ.get(JSON.stringify(p)) || [], dups: () => [...occ.entries()].filter(([, v]) => v.length > 1).map(([k]) => JSON.parse(k)) };
}

// The ONE value written at a path: the path and every container above it must be written exactly once (all(path) would join the children of
// a container written twice, so a repeated container whose last copy is empty would prove a model). undefined when the path is written zero or several times
// (even with equal values) or a container above it is.
function single(j, p) {
  for (let n = 1; n <= p.length; n++) if (j.all(p.slice(0, n)).length !== 1) return undefined;
  return j.all(p)[0];
}

// dahl: the LAST non-blank line of stdout must be "AGENT_RESULT {json}" (the agent prints it once, last; the model's text goes to its transcript file). An
// earlier AGENT_RESULT line (anything above the last line) is never read; a last line that is not such a line, or whose JSON does not name a model, is no proof.
// The gate runs FIRST on every candidate id, before the conflict comparison and before any detail is built; every detail is fixed code.
// The whole stream is strict text (strictStream) before any line of it is read.
function fromAgentResult(text, gate) {
  const whole = strictStream(text);
  if (whole === null) return { model: null, reason: 'unreadable client stream', detail: 'the stream that holds the AGENT_RESULT line is not strict text (invalid UTF-8, a lone surrogate, a BOM, NUL or an invisible character); no proof' };
  const last = tailLine(whole);
  if (!last) return null;
  const m = /^AGENT_RESULT(?:[\t ]+(.*?))?[\t ]*$/.exec(last.text);
  if (!m) return null;
  let j = null; try { j = parseJsonAll(m[1]); } catch { /* not JSON */ }
  if (!j || !j.value || typeof j.value !== 'object' || Array.isArray(j.value)) return { model: null, reason: 'unreadable agent result', detail: `the last line (line ${last.line}) is an AGENT_RESULT that is not JSON; no proof` };
  // Unique keys - ANY key of the record written twice ("model", "ok", "role", ...), even with equal
  // values, is not one well-formed record (PROTO-DEC-0209 item 3), so the line names no model: no proof
  const dups = j.dups();
  if (dups.length) return { model: null, reason: 'ambiguous agent result', detail: `the AGENT_RESULT line (line ${last.line}) writes a key more than once; no proof` };
  const candidate = modelIdOf(j.value.model);
  if (!candidate) return { model: null, reason: 'unknown agent result', detail: 'the AGENT_RESULT line names no model id of the closed grammar (empty, blanks, a placeholder or invisible characters); no proof' };
  // A refused id is NOT a record. Every AGENT_RESULT line of the stream that is one well-formed record naming
  // one model id of the closed grammar is a record; the gate runs on each BEFORE it enters any comparison, and the source speaks the
  // refusal of the allow-list only when EVERY record of the stream was refused - never on the last line alone. A listed record beside a
  // refused one proves (the refused id is not compared and never printed), whichever line each of them sits on.
  const records = []; let refusedOne = false;
  const consider = (raw, line) => {
    const r = /^AGENT_RESULT(?:[\t ]+(.*?))?[\t ]*$/.exec(raw);
    if (!r) return;
    let k = null; try { k = parseJsonAll(r[1]); } catch { /* not JSON */ }
    if (!k || !k.value || typeof k.value !== 'object' || Array.isArray(k.value) || k.all(['model']).length > 1 || k.dups().length) return;
    const id = modelIdOf(k.value.model);
    if (!id) return;
    if (gate(id)) records.push({ model: id, line });
    else refusedOne = true;
  };
  consider(last.text, last.line);
  for (const [i, line] of whole.split('\n').entries()) { if (i + 1 === last.line) continue; consider(line, i + 1); }
  if (!records.length) return refusedOne
    ? { model: null, reason: 'model not in allow-list', detail: 'every AGENT_RESULT record of the stream names a model id the allow-list of the client refuses; the ids are not recorded; no proof' }
    : null;
  // Records of one stream that disagree make it ambiguous: never the first, never the last record alone
  if (records.some(r => r.model !== records[0].model)) return { model: null, reason: 'ambiguous agent result', detail: `the stream holds AGENT_RESULT records that name different models (line ${records[0].line} beside line ${records.find(r => r.model !== records[0].model).line}); no proof` };
  return { model: records[0].model, detail: `AGENT_RESULT line ${last.line}` };
}

// codex exec prints a header block before anything else: a line "OpenAI Codex ...", a "--------" line, "key: value" fields (workdir, model, provider, ...) and a
// second "--------" line. Only a block that OPENS a stream (its first non-blank line) is the client's header; a "model:" line of an echoed prompt or of the answer,
// or a block further down, is not read. The block must be closed by its separator line within 30 lines (else reason "unclosed header"), hold only field lines
// (else "malformed header"), name a model ("unknown header") and name one model only; the blocks of two streams must agree ("conflicting headers").
// The header grammar takes the ASCII space and tab only as its blanks (\s would also match NBSP and every other Unicode
// whitespace); a model value is stripped by the same one strip, never trim().
const SEPARATOR = /^-{4,}[\t ]*$/;
const FIELD = /^[A-Za-z][A-Za-z ]{0,30}:(?:[\t ].*)?$/;
// ONE model line per block. Every line whose key is "model" counts, whatever its value (an empty "model:" line is a second line, not
// nothing), so a named line plus an empty one, two equal lines and two different lines all end the proof (reason "conflicting headers" for different values,
// "repeated model line" for equal ones); a single line whose value is empty or has several words names no model ("unknown header").
const isModelKey = line => { const at = line.indexOf(':'); return at > 0 && stripBlank(line.slice(0, at)).toLowerCase() === 'model'; };
// Unique keys - the codex header is a record of "key: value" fields, and a block that writes ANY
// field key twice (workdir, provider, ...; even with equal values; the model key keeps its own rule above) is not one
// well-formed record of the schema: no proof. -> the first duplicated field key of lines[from, to), or null.
const duplicatedFieldKey = (lines, from, to) => {
  const keys = [];
  for (let k = from; k < to; k++) { const at = lines[k].indexOf(':'); keys.push(stripBlank(lines[k].slice(0, at)).toLowerCase()); }
  const dup = keys.find((key, idx) => keys.indexOf(key) !== idx);
  return dup === undefined ? null : dup;
};
function fromCodexHeader(input, gate) {
  const models = []; let blocks = 0; let refused = false;
  for (const stream of [].concat(input)) {
    // The whole stream is strict text before any line of it is read (a NUL in any field, an invisible character, a BOM,
    // a lone surrogate or a damaged byte refuse the stream; it spoke and cannot name a model)
    const whole = strictStream(stream);
    if (whole === null) return { model: null, reason: 'unreadable client stream', detail: 'a client stream that opens the codex header is not strict text (invalid UTF-8, a lone surrogate, a BOM, NUL or an invisible character); no proof' };
    const lines = headLines(whole);
    if (!/^OpenAI Codex\b/.test(lines[0] || '') || !SEPARATOR.test(lines[1] || '')) continue;
    blocks++;
    const own = [];
    let i = 2;
    for (; i < lines.length && i < 30 && !SEPARATOR.test(lines[i]); i++) if (isModelKey(lines[i])) own.push({ value: stripBlank(lines[i].slice(lines[i].indexOf(':') + 1)), line: i + 1 });
    if (!SEPARATOR.test(lines[i] || '')) return { model: null, reason: 'unclosed header', detail: 'the codex header block at the start of a stream has no closing separator line; no proof' };
    if (lines.slice(2, i).some(l => !FIELD.test(l))) return { model: null, reason: 'malformed header', detail: 'the codex header block holds a line that is not a "key: value" field; no proof' };
    if (own.length > 1) {
      const same = own.every(o => o.value === own[0].value);
      return { model: null, reason: same ? 'repeated model line' : 'conflicting headers', detail: `a codex header block holds ${own.length} model lines (lines ${own.map(o => o.line).join(', ')}; ${same ? 'equal values' : 'different or empty values'}); no proof` };
    }
    if (!own.length || !modelIdOf(own[0].value)) return { model: null, reason: 'unknown header', detail: 'every codex header block must name exactly one model id of the closed grammar; no proof' };
    // A non-model field key written twice (even with equal values) is not one well-formed record: no proof
    const dupKey = duplicatedFieldKey(lines, 2, i);
    if (dupKey !== null) return { model: null, reason: 'repeated header key', detail: 'the codex header block writes a field key more than once; no proof' };
    // The allow-list gate runs FIRST, before the conflict comparison and before any detail is built; a refused id is not a record
    // of the schema (it names no model id), is never compared and never printed. Only when EVERY record of the source is refused does the
    // source speak the refusal itself.
    const candidate = modelIdOf(own[0].value);
    if (gate(candidate)) models.push({ model: candidate, line: own[0].line });
    else refused = true;
    // A stream that OPENS with the client's header block is the client's own, so a second header-shaped block anywhere in it
    // is a record of the same schema: a second record that names another model makes the stream conflicting, never the first block alone. A
    // second block that is malformed, unclosed, holds no or several model lines or names no gated model id is not a record and is not
    // read. A stream that does not open with the header block holds echoes and is never scanned.
    for (let k = i + 1; k < lines.length; k++) {
      if (!/^OpenAI Codex\b/.test(lines[k] || '') || !SEPARATOR.test(lines[k + 1] || '')) continue;
      blocks++;
      const second = [];
      let e = k + 2;
      for (; e < lines.length && e < k + 32 && !SEPARATOR.test(lines[e]); e++) if (isModelKey(lines[e])) second.push({ value: stripBlank(lines[e].slice(lines[e].indexOf(':') + 1)), line: e + 1 });
      if (!SEPARATOR.test(lines[e] || '') || lines.slice(k + 2, e).some(l => !FIELD.test(l)) || second.length !== 1 || duplicatedFieldKey(lines, k + 2, e) !== null) continue;
      const value = modelIdOf(second[0].value);
      if (value && gate(value)) models.push({ model: value, line: second[0].line });
    }
  }
  if (!models.length) return refused ? { model: null, reason: 'model not in allow-list', detail: 'the codex header block names a model id the allow-list of the client refuses; the id is not recorded; no proof' } : null;
  if (models.some(m => m.model !== models[0].model)) return { model: null, reason: 'conflicting headers', detail: `the codex header blocks of the client streams name different models (${blocks} header block(s)); no proof` };
  return { model: models[0].model, detail: `header line ${models[0].line}${models.length > 1 ? ` (${models.length} header blocks of the client streams, all the same)` : ''}` };
}

// ---- provenance of a file: the identity of the READ object, proven at read time ----
// A file is evidence only when it is a regular file that lies inside the client's own directory (the mimo log directory, the vibe session store, the client log
// directory the caller named): no symbolic link or junction on the way below that directory, no hard link (link count above 1), and its real path inside the real
// path of the directory. The directory itself is the caller's choice and may be a link. The identity is judged OF THE OBJECT THE READ ITSELF USES, never
// of the name before the read. The shared guarded reader opens the file once, reads its bytes from that descriptor and verifies afterwards that the name still
// names the same file (device and inode), still a regular file with one link at the same real path inside the own directory: a check made before the open says
// nothing about the object a later read uses, and a swap of the name between the check and the read (a link put at the name) is caught after the read, with no
// byte of the swapped file ever entering a proof. -> the bytes of the file, or null (foreign or unverifiable: not read, changes nothing).
function readOwnFile(dir, file) {
  try {
    const g = pathSafe.readFileGuarded(dir, file);
    return g.ok ? g.bytes : null;
  } catch { return null; }
}


const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
// The ONE grammar of how the requested model reached the client (.ai/bin/launch-record.cjs requestedModelVia, the record writer's own field);
// deriveForLaunch is its only production caller and always hands it the vibe alias mapping.
const launchRecordTool = require('../../.ai/bin/launch-record.cjs');

// A structured stream is decoded as a WHOLE before any trim or split: a BOM, NUL, a lone surrogate, invalid UTF-8 and a CR that is not a
// CRLF refuse the whole source (CRLF itself is normalised). An invisible or format character
// REFUSES the stream too (invisible:'refuse'), as every other class of the shared decoder - including the NBSP of the real codex banner fixture
// (its token line carries U+00A0; under the closed rule the whole stream refuses, and the positive controls of the tests normalise that one byte
// to a space in-test, while a named case proves the raw fixture refuses). The class of a line made only of U+FEFF or another invisible
// character is refused here, before any split; the JSON-whitespace blank rule of jsonEventStream stands below it.
// -> the decoded text, or null (refused).
function strictStream(text) {
  const d = textSafe.decodeText(String(text ?? ''), { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  return d.ok ? d.text : null;
}

// ---- G3 (PROTO-DEC-0215 item 3): the one allow-list every source passes through ----
// .ai/docs/clients.json is read through the shared strict reader (a regular file of its own, no link, text-safe decode, unique-key parsing):
// a model id is accepted only when clients[client].models lists it, or when it is the alias of a listed name (launchAliases of the same entry:
// vibe serves the alias glm-5-3 of the listed name zai-glm-5-3). A caller that owns another registry passes input.allowModels (the ids it accepts
// for the client) or input.clientsFile (the registry file to read); the gate itself never widens. A refused id is never printed and never stored.
const CLIENTS_FILE = path.join(__dirname, '..', '..', '.ai', 'docs', 'clients.json');
function clientAllowList(client, input = {}) {
  if (Array.isArray(input.allowModels)) return { models: input.allowModels.filter(v => typeof v === 'string'), aliases: {} };
  const file = typeof input.clientsFile === 'string' && input.clientsFile ? input.clientsFile : CLIENTS_FILE;
  const bytes = readOwnFile(path.dirname(file), path.basename(file));
  if (bytes === null) return null;
  const d = textSafe.decode(bytes, { bom: 'refuse', crlf: 'normalise' });
  if (!d.ok) return null;
  let j = null;
  try { j = parseJsonAll(d.text); } catch { return null; }
  if (!j || j.dups().length || !j.value || typeof j.value !== 'object' || Array.isArray(j.value)) return null;
  const entry = single(j, ['clients', client]);
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.models)) return null;
  const aliases = entry.launchAliases && typeof entry.launchAliases === 'object' && !Array.isArray(entry.launchAliases) ? entry.launchAliases : {};
  return { models: entry.models.filter(v => typeof v === 'string'), aliases };
}
// -> the id when the allow-list of the client accepts it, else null (the id is then never printed, never compared, never stored)
function allowedModel(client, id, input = {}) {
  if (typeof id !== 'string' || !id) return null;
  const list = clientAllowList(String(client || '').toLowerCase(), input);
  if (!list) return null;
  if (list.models.includes(id)) return id;
  const ofListedName = Object.keys(list.aliases).find(name => list.aliases[name] === id && list.models.includes(name));
  return ofListedName ? id : null;
}

// ---- G2 (PROTO-DEC-0215 item 2): the one reader of a client JSON event stream ----
// A stream is a proof source only when EVERY non-empty line of the WHOLE stream is one JSON object (each line through the shared strict decoder
// and unique-key parsing). ONE other line - free text, a hidden or non-ASCII prefix before the object, a damaged byte, a JSON object inside a
// message - makes the whole stream "no structured source". No line is ever searched for JSON inside text.
// The WHOLE stream is decoded by the shared strict decoder BEFORE any split, and a line is BLANK only when it is JSON whitespace
// (spaces and tabs): a line made only of U+FEFF or another invisible or format character is a NON-EMPTY line and refuses the stream.
// -> { ok: true, records } | { ok: false, reason: 'no structured source', line } (line 0: the whole stream was refused as text)
function jsonEventStream(text) {
  const whole = strictStream(text);
  if (whole === null) return { ok: false, reason: 'no structured source', line: 0 };
  const records = [];
  for (const [i, raw] of whole.split('\n').entries()) {
    if (/^[\t ]*$/.test(raw)) continue;
    let parsed = null;
    try { parsed = parseJsonAll(raw); } catch { parsed = null; }
    if (!parsed || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value) || parsed.dups().length) return { ok: false, reason: 'no structured source', line: i + 1 };
    records.push(parsed.value);
  }
  return { ok: true, records };
}

// ---- G1 (PROTO-DEC-0215 item 1): the vibe export of the launcher-fixed output directory ----
// The launcher creates a NEW EMPTY directory per launch and starts vibe with `--output-dir <dir>`; vibe writes export.json (the observed export of
// vibe 2.26.1, 2026-10-18) there on every exit. The served model is read ONLY from that file: never from the session store (deleted with the
// former scan), never from a printed session line, never from a client log file. The file is read through
// the guarded reader (a regular file inside the launcher's own directory, no link, no hard link, the identity of the read object at read time),
// decoded by the shared strict decoder and parsed with unique keys; the model sits at ONE fixed path (VIBE_EXPORT_MODEL_PATH, the constant).
// -> { model, detail } | { model: null, reason, detail }
const VIBE_EXPORT_FILE = 'export.json';
const VIBE_EXPORT_MODEL_PATH = ['config', 'active_model'];
function fromVibeExport(exportDir) {
  // absent and foreign are SILENT (as for every source: no export directory given, no export.json the client wrote, or a file that is
  // not the launcher directory's own - a link): the source has no evidence, and a source that spoke but cannot name one model carries its reason
  if (typeof exportDir !== 'string' || !exportDir.trim()) return null;
  const bytes = readOwnFile(exportDir, VIBE_EXPORT_FILE);
  if (bytes === null) return null;
  const d = textSafe.decode(bytes, { bom: 'refuse', crlf: 'normalise' });
  if (!d.ok) return { model: null, reason: 'unreadable vibe export', detail: `${VIBE_EXPORT_FILE} of the launch is not strict text (invalid UTF-8, a lone surrogate, a BOM or NUL); no proof` };
  let j = null;
  try { j = parseJsonAll(d.text); } catch { /* not JSON */ }
  if (!j || !j.value || typeof j.value !== 'object' || Array.isArray(j.value)) return { model: null, reason: 'unreadable vibe export', detail: `${VIBE_EXPORT_FILE} of the launch is not one JSON object of the whole file; no proof` };
  if (j.dups().length) return { model: null, reason: 'unreadable vibe export', detail: `${VIBE_EXPORT_FILE} of the launch writes a key more than once; no proof` };
  const model = modelIdOf(single(j, VIBE_EXPORT_MODEL_PATH));
  if (!model) return { model: null, reason: 'unknown vibe export', detail: `${VIBE_EXPORT_FILE} of the launch names no model id at the fixed path ${VIBE_EXPORT_MODEL_PATH.join('.')} (empty, a placeholder, blanks or invisible characters); no proof` };
  return { model, detail: `${VIBE_EXPORT_FILE} of the launcher-fixed output directory (field ${VIBE_EXPORT_MODEL_PATH.join('.')})` };
}


// The proofs of one launch are combined, never picked one after the other. A proof is one of: null (that source has no evidence), { model, detail }
// (it names one model) or { model: null, reason, detail } (it spoke and could not name one model: ambiguous, unnamed, not tied to the launch). When two or more
// sources have spoken, a single one proves only if EVERY one of them names a model and the models are the same one (modelsMatch: a provider prefix is no difference);
// else the served model is unknown with the reason "conflicting sources" (a log that is ambiguous contradicts a banner that names one model, whichever way round).
// The first agreeing part, in the order given (highest rank first), supplies the model, the source and the confidence. The explicit --model (requestedModel) is
// NOT a part: it says what was asked, so a proven model that differs from it keeps the existing answer match=false (the launcher's mismatch marker), and it can
// never make a model proven. -> the part that supplies the proof ({ name, source, confidence, proof }) | { proof: { model: null, reason, detail } } | null
function combineProofs(parts) {
  const spoke = parts.filter(p => p.proof);
  if (!spoke.length) return null;
  if (spoke.length === 1) return spoke[0];
  const named = spoke.filter(p => p.proof.model);
  const agree = named.length === spoke.length && named.every(p => modelsMatch(named[0].proof.model, p.proof.model) === true);
  if (agree) return spoke[0];
  // The disagreement detail is fixed code - it names the sources and their fixed reasons, never a model id
  return { proof: { model: null, reason: 'conflicting sources', detail: `the sources of one launch disagree (${spoke.map(p => `${p.name} ${p.proof.model ? 'names another model' : `gives no model (${p.proof.reason || 'no reason'})`}`).join('; ')}); no proof` } };
}

// ---- The decision table (PROTO-DEC-0190; reduced to the structured sources of PROTO-DEC-0209) ----
// The decision is written down as a table, and a generated test builds a fixture for EVERY cell
// and asserts the outcome the cell names. A cell is one point of these dimensions:
//   source state (per admissible source)   absent      the source has no evidence at all (no line, no file, no session)
//                                          one         it names exactly one model
//                                          several     it names several models (two models in one source, one key written twice, sessions that disagree)
//                                          malformed   it spoke and cannot be read, or names no model (not JSON, unclosed header, a line without a model)
//                                          foreign     provenance not proven: a stream the client does not own (stdout carries the model's answer), a log of another
//                                                      directory or outside the launch window, a file outside the client's own log directory, a text without a file
//   sessions printed by the client         none printed / one printed / several printed (every one found in an admissible log or session store)
//   and found                              mismatch: at least one printed session is not found there
//   agreement across the sources           all agree / any disagree (meaningful when two sources both name one model; elsewhere both give one outcome)
// One source (reading[sessions][state]): foreign and absent are SILENT (a foreign file is never read, so it cannot change the result: it is as if it did
// not exist); one names the model; several and malformed are NEGATIVE (the source spoke and did not name one model). The sessions a client printed bind the
// other way: when it printed a session that no admissible log holds (or holds only a foreign one), the source is NEGATIVE with "printed session not proven",
// whatever else it holds, and also when there is no log at all. Two sources (combine): both silent -> unknown (no evidence); one speaks -> that source alone
// (its model, or its own negative reason); both name one model and agree -> the first one; both name one model and disagree, or any negative beside a speaker
// -> unknown "conflicting sources". A proven model is compared with the requested one only for the marker: the same -> exact (match yes), another -> mismatch
// (match no, the launchers' SERVED_MODEL_MISMATCH). Unknown never carries a model, a source or a confidence; "no evidence" carries no reason on the result.
const TABLE = {
  states: ['absent', 'one', 'several', 'malformed', 'foreign'],
  sessions: ['none printed', 'one printed', 'several printed', 'mismatch'],
  agreement: ['all agree', 'any disagree'],
  requested: ['same', 'different'],
  // reading of ONE source, by sessions then state: silent | one | negative:several | negative:malformed | negative:mismatch
  reading: {
    'none printed': { absent: 'silent', one: 'one', several: 'negative:several', malformed: 'negative:malformed', foreign: 'silent' },
    'one printed': { absent: 'negative:mismatch', one: 'one', several: 'negative:several', malformed: 'negative:malformed', foreign: 'negative:mismatch' },
    'several printed': { absent: 'negative:mismatch', one: 'one', several: 'negative:several', malformed: 'negative:malformed', foreign: 'negative:mismatch' },
    mismatch: { absent: 'negative:mismatch', one: 'negative:mismatch', several: 'negative:mismatch', malformed: 'negative:mismatch', foreign: 'negative:mismatch' },
  },
  mismatchReason: 'printed session not proven',
  // two sources, by the kinds of their readings (silent | one | negative): the outcome (proven:<index of the source that supplies the proof> | unknown:<reason>)
  combine: {
    'silent+silent': 'unknown:no evidence',
    'one+silent': 'proven:0', 'silent+one': 'proven:1',
    'negative+silent': 'unknown:negative:0', 'silent+negative': 'unknown:negative:1',
    'one+one': { 'all agree': 'proven:0', 'any disagree': 'unknown:conflicting sources' },
    'one+negative': 'unknown:conflicting sources', 'negative+one': 'unknown:conflicting sources', 'negative+negative': 'unknown:conflicting sources',
  },
  oneSource: { silent: 'unknown:no evidence', one: 'proven:0', negative: 'unknown:negative:0' },
  requestedOutcome: { same: 'exact', different: 'mismatch' },
};
// The sources of each client with the forms each state takes there (a form is one concrete way to be in that state; its reason is the one the source gives
// when it is negative). needs = the sessions values in which the form can be built at all (two sessions that differ need two sessions).
const ALL_SESSIONS = TABLE.sessions;
// Every form carries dev = the kind of deviation of the source it stands for. A source is a proof only when it is one well-formed record of its known
// schema that names exactly one non-empty model exactly once; every other shape of it is a form below, in one of these kinds (DEVIATIONS): empty (the model is
// missing or has no value), duplicate (the model is written twice with different values, or two models), repeated-identical (written twice with EQUAL values or in
// a repeated container: it still names no single model), malformed (not the schema), truncated (cut off before its end), extra (an additional model or record
// beside the first), link (the file is a link, a hard link, or lies outside the own directory of the client: foreign). A generated test checks that each source
// has a form of every kind or says why none applies (NOT_APPLICABLE, by the id of the source), and the table crosses every form with the sessions, the second
// source and the requested model.
const DEVIATIONS = ['empty', 'duplicate', 'repeated-identical', 'malformed', 'truncated', 'extra', 'link'];
const NOT_APPLICABLE = {
  'agy launcher flag': {
    duplicate: 'the argv grammar reads the LAST model flag, so one value reaches the client; a flag naming another model is not-passed, never two models',
    'repeated-identical': 'one flag, one value: the argv grammar leaves no way to write the same value twice as one pass',
    truncated: 'the flag value is one whole word of the argv, never a cut-off tail',
    extra: 'nothing follows the value in the record; there is no second field that could be extra',
    link: 'no file is read: the source is a fact of the argv the launcher really started the client with',
  },
  'dahl result line': { link: 'the result line is a line of stdout, not a file' },
  'codex header': {},
  'vibe export': {
    extra: 'the export is ONE JSON object and the model sits at ONE fixed path; there is no second record or second model field beside the first (a second object makes the file not JSON, which is the malformed form), and an unlisted id is refused by the allow-list gate (PROTO-DEC-0215 item 3), which sits above the table',
  },
};
const OWN_DIR = 'the own directory of the client';
const LINK_FORMS = what => [{ form: `${what} is a hard link to a file outside ${OWN_DIR}`, dev: 'link' }, { form: `${what} is a symbolic link to a file outside ${OWN_DIR}`, dev: 'link' }];
const DAHL_SEVERAL = [{ form: 'key model written twice', reason: 'ambiguous agent result', dev: 'duplicate' }, { form: 'key model written twice with equal values', reason: 'ambiguous agent result', dev: 'repeated-identical' },
  { form: 'two AGENT_RESULT lines of the stream name different models', reason: 'ambiguous agent result', dev: 'duplicate' },
  // Any key of the record written twice refuses, never only the model key
  { form: 'a non-model key of the result written twice', reason: 'ambiguous agent result', dev: 'duplicate' }];
const DAHL_MALFORMED = [{ form: 'last line is not JSON', reason: 'unreadable agent result', dev: 'malformed' }, { form: 'last line names no model', reason: 'unknown agent result', dev: 'empty' },
  { form: 'model value empty', reason: 'unknown agent result', dev: 'empty' }, { form: 'last line truncated', reason: 'unreadable agent result', dev: 'truncated' }, { form: 'a second JSON object after the first', reason: 'unreadable agent result', dev: 'extra' },
  // An invisible or format character in the stream bytes refuses the whole stream at the strict decode of the one entry
  // point, before any line is read
  { form: 'model value holds invisible or format characters', reason: 'unreadable client stream', dev: 'malformed' },
  // A placeholder value names the absence of a model, never a model id
  { form: 'model value is a placeholder (unknown, none, null)', reason: 'unknown agent result', dev: 'empty' }];
// A client log file above the read limit is an unreadable source, never a head-and-tail prefix (the result line
// of stdout is a stream the caller gives whole: no read limit, no such form)
const DAHL_LOG_MALFORMED = [
  // The invisible form of a client LOG refuses the log at its own guarded read (invisible:'refuse' of the shared decoder)
  { form: 'model value holds invisible or format characters', reason: 'unreadable client log', dev: 'malformed' },
  ...DAHL_MALFORMED.filter(f => f.form !== 'model value holds invisible or format characters'), { form: 'client log above the read limit', reason: 'client log above the read limit', dev: 'truncated' },
  // A client log that is not strict text is an unreadable source (the shared decoder refused it)
  { form: 'client log is not strict text (a damaged byte, a BOM or NUL)', reason: 'unreadable client log', dev: 'malformed' }];
const SHAPES = {
  dahl: { sources: [
    { name: 'result line of stdout', id: 'dahl result line', source: 'agent-result', confidence: 'exact', logType: false,
      several: DAHL_SEVERAL, malformed: DAHL_MALFORMED,
      foreign: [{ form: 'result line above the last line' }] },
    { name: 'client log file', id: 'dahl log file', source: 'client-log', confidence: 'derived', logType: false,
      several: DAHL_SEVERAL, malformed: DAHL_LOG_MALFORMED,
      foreign: [{ form: 'file outside the client log directory' }, { form: 'file written outside the launch window' }, { form: 'text without a file' }, ...LINK_FORMS('file')] }] },
  codex: { sources: [
    { name: 'header block of the client streams', id: 'codex header', source: 'client-banner', confidence: 'exact', logType: false,
      several: [{ form: 'two model lines', reason: 'conflicting headers', dev: 'duplicate' }, { form: 'model line repeated with the same value', reason: 'repeated model line', dev: 'repeated-identical' },
        { form: 'named model line plus an empty model line', reason: 'conflicting headers', dev: 'extra' },
        { form: 'a second header block of the stream names another model', reason: 'conflicting headers', dev: 'extra' },
        // Any field key of the block written twice refuses, never only the model key
        { form: 'a non-model field key written twice', reason: 'repeated header key', dev: 'duplicate' }],
      malformed: [{ form: 'block never closed', reason: 'unclosed header', dev: 'malformed' }, { form: 'block without a model', reason: 'unknown header', dev: 'empty' }, { form: 'line that is not a field', reason: 'malformed header', dev: 'malformed' },
        { form: 'model line empty', reason: 'unknown header', dev: 'empty' }, { form: 'model value with two words', reason: 'unknown header', dev: 'extra' }, { form: 'block truncated after the model line', reason: 'unclosed header', dev: 'truncated' },
        { form: 'model value holds invisible or format characters', reason: 'unreadable client stream', dev: 'malformed' },
        // A log above the read limit is an unreadable source, never a head-and-tail prefix
        { form: 'client log above the read limit', reason: 'client log above the read limit', dev: 'truncated' },
        // A log that is not strict text is an unreadable source; a placeholder names no model
        { form: 'client log is not strict text (a damaged byte, a BOM or NUL)', reason: 'unreadable client log', dev: 'malformed' },
        { form: 'model value is a placeholder (unknown, none, null)', reason: 'unknown header', dev: 'empty' }],
      foreign: [{ form: 'header at the start of stdout' }, { form: 'file outside the client log directory' }, { form: 'file written outside the launch window' }, { form: 'text without a file' }, ...LINK_FORMS('file')] }] },
  vibe: { sources: [
    // PROTO-DEC-0215 item 1: the one source of vibe is the export.json of the launcher-fixed output directory, read only at the fixed
    // field path. The session store, the printed session lines and the client log files are not sources, and with them the whole sessions
    // dimension of this client's cells is gone (logType false); the allow-list gate (item 3) sits above the table and has its own cases.
    { name: 'the export file of the launcher-fixed output directory', id: 'vibe export', source: 'client-log', confidence: 'derived', logType: false,
      several: [{ form: 'the model field written twice with different values', reason: 'unreadable vibe export', dev: 'duplicate' },
        { form: 'the model field written twice with equal values', reason: 'unreadable vibe export', dev: 'repeated-identical' },
        // the export is one JSON object with unique keys: a key written twice is not one well-formed record
        { form: 'a non-model key of the export written twice', reason: 'unreadable vibe export', dev: 'duplicate' }],
      malformed: [{ form: 'the export is not strict text (a damaged byte, a BOM or NUL)', reason: 'unreadable vibe export', dev: 'malformed' },
        { form: 'the export is not one JSON object of the whole file', reason: 'unreadable vibe export', dev: 'malformed' },
        { form: 'the export truncated after the model field', reason: 'unreadable vibe export', dev: 'truncated' },
        { form: 'the model field is empty', reason: 'unknown vibe export', dev: 'empty' },
        { form: 'the model value holds invisible or format characters', reason: 'unknown vibe export', dev: 'malformed' },
        // Behind the gate: a placeholder names the absence of a model, and the allow-list refuses it besides
        { form: 'the model value is a placeholder (unknown, none, null)', reason: 'unknown vibe export', dev: 'empty' }],
      foreign: [...LINK_FORMS('the export file')] }] },
  agy: { requested: ['same'], sources: [
    { name: 'the --model flag the launcher passed', id: 'agy launcher flag', source: 'launcher-model', confidence: 'derived', logType: false,
      several: [],
      malformed: [
        // requestedModelVia is computed from the real argv, and the via grammar reads no request from an empty value, so an
        // empty flag value is not-passed (the flag never reached the client): no evidence, no reason - not an unknown launcher flag.
        { form: 'the flag value is empty', reason: 'no evidence', dev: 'empty' },
        { form: 'the flag value holds blanks (not one well-formed model id)', reason: 'unknown launcher flag', dev: 'malformed' },
        { form: 'the flag value holds invisible or format characters', reason: 'unknown launcher flag', dev: 'malformed' },
        // A placeholder flag value names the absence of a model, never a model id
        { form: 'the flag value is a placeholder (unknown, none, null)', reason: 'unknown launcher flag', dev: 'empty' }],
      foreign: [{ form: 'the model did not reach agy by flag (requestedModelVia not-passed or alias-env)' }] }] },
};
// the variants of one source: [{ state, form, reason?, needs? }]
function variantsOf(src) {
  return [{ state: 'absent', form: 'no evidence' }, { state: 'one', form: 'names one model' },
    ...src.several.map(f => ({ state: 'several', ...f })), ...src.malformed.map(f => ({ state: 'malformed', ...f })), ...src.foreign.map(f => ({ state: 'foreign', ...f }))];
}
// the outcome of one cell: { kind: 'exact'|'mismatch'|'unknown', by?, reason? }; variants = one per source, sessions, agreement, requested
function decide(shape, variants, sessions, agreement, requested) {
  const readings = variants.map((v, i) => {
    const r = TABLE.reading[shape.sources[i].logType ? sessions : 'none printed'][v.state];
    if (r === 'silent' || r === 'one') return { kind: r };
    return { kind: 'negative', reason: r === 'negative:mismatch' ? TABLE.mismatchReason : v.reason };
  });
  let answer;
  if (readings.length === 1) answer = TABLE.oneSource[readings[0].kind];
  else {
    answer = TABLE.combine[`${readings[0].kind}+${readings[1].kind}`];
    if (answer && typeof answer === 'object') answer = answer[agreement];
  }
  const m = /^unknown:negative:(\d)$/.exec(answer);
  if (m) return { kind: 'unknown', reason: readings[Number(m[1])].reason };
  if (answer.startsWith('unknown:')) return { kind: 'unknown', reason: answer.slice('unknown:'.length) };
  return { kind: TABLE.requestedOutcome[requested], by: Number(answer.slice('proven:'.length)) };
}
// EVERY cell of one client's shape: { id, variants, sessions, agreement, requested, outcome }
function cells(clientName) {
  const shape = SHAPES[clientName];
  if (!Object.hasOwn(SHAPES, clientName)) throw new Error(`served-model: no decision-table shape for client ${clientName}`);
  const out = [];
  const sessionsList = shape.sources.some(s => s.logType) ? TABLE.sessions : [TABLE.sessions[0]];
  const per = shape.sources.map(variantsOf);
  const combos = per.reduce((acc, vs) => acc.flatMap(a => vs.map(v => [...a, v])), [[]]);
  for (const sessions of sessionsList) for (const variants of combos) {
    if (variants.some((v, i) => shape.sources[i].logType && v.needs && !v.needs.includes(sessions))) continue;
    for (const agreement of shape.sources.length > 1 ? TABLE.agreement : [null]) for (const requested of (shape.requested || TABLE.requested)) {
      const outcome = decide(shape, variants, sessions, agreement, requested);
      if (outcome.kind === 'unknown' && requested !== TABLE.requested[0]) continue; // requested is a dimension of the proven cells only
      out.push({ id: `${clientName} | ${variants.map(v => `${v.state}: ${v.form}`).join(' | ')} | ${sessions}${agreement ? ` | ${agreement}` : ''}${outcome.kind === 'unknown' ? '' : ` | requested ${requested}`}`, variants, sessions, agreement, requested, outcome });
    }
  }
  return out;
}
// What a derivation result says, in the terms of a cell outcome
function outcomeOf(result) {
  if (result.servedModel && result.match === true) return { kind: 'exact', source: result.source, confidence: result.confidence };
  if (result.servedModel && result.match === false) return { kind: 'mismatch', source: result.source, confidence: result.confidence };
  return { kind: 'unknown', reason: result.reason || 'no evidence' };
}

// The streams a caller gives, by who writes them. own = the streams the CLIENT writes its own lines to: stderr (only when the caller has the
// streams apart, i.e. gave input.stdout or input.stderr as a string) and the client log files the caller names (input.logFiles, admissible ones only; each read as a stream of
// its own). out = the stream of the model's answer (stdout, or the whole capture when the caller has no separate streams): never a proof for codex.
// PROTO-DEC-0215: the vibe branch reads no stream at all (its proof is the export file of input.exportDir), so a mixed capture
// of a vibe launch is never joined and never parsed here.
function streamsOf(input) {
  const logs = clientLogTexts(input);
  // Only a log that was read WHOLE is a stream of the derivation; an admissible log above the read limit
  // is not judged from a prefix (the branches read the { oversize } markers and speak the reason themselves)
  const logTexts = logs.filter(l => typeof l === 'string');
  const apart = typeof input.stdout === 'string' || typeof input.stderr === 'string';
  const stderr = typeof input.stderr === 'string' ? input.stderr : '';
  const capture = typeof input.capturedOutput === 'string' ? input.capturedOutput : '';
  if (apart) { const out = typeof input.stdout === 'string' ? input.stdout : ''; return { out, own: [stderr, ...logTexts], logs }; }
  return { out: capture, own: [...logTexts], logs };
}

// A client log file a caller names (input.logFiles) is admissible only with its provenance proven: the file lies inside the client's own log directory
// (input.clientLogDir; its real path, no link, no hardlink), is a regular file and was last written inside the launch window [startedAt - slack, endedAt + slack]
// (the mimo launches use the window of the client's own start times; a transcript the model wrote or an older file fails the window). A file that fails any
// of this is FOREIGN: it is not read and changes nothing. A text a caller passes without a file (the old input.logStreams) has no provenance and is never read.
// The file is read WHOLE (the guarded reader itself reads the whole file from the opened descriptor; no head-and-tail prefix is
// ever judged: a second header block or a second AGENT_RESULT in the unread middle would be lost and the prefix could prove the first record alone).
// A file above LOG_KEEP is admissible but UNREADABLE: it returns the marker { oversize } and the source it stands for spoke and names no model -
// unknown with the reason "client log above the read limit", never a decision from a prefix. The read goes through the guarded reader, so the
// identity of the file is judged of the object the read itself uses, at read time, and the size and the launch window are judged of the OPENED DESCRIPTOR
// of the bytes actually read (the fstat the guard itself took), never of a later stat of the name: a name swapped for a fresh file after the read cannot lend its mtime.
const LOG_KEEP = 256 * 1024;
function readClientLog(file, dir, s, e) {
  if (typeof file !== 'string' || !file || typeof dir !== 'string' || !dir || Number.isNaN(s) || Number.isNaN(e)) return null;
  try {
    // The size is judged by the fstat of the OPENED DESCRIPTOR BEFORE any byte is read (the guard's
    // maxBytes): a file above LOG_KEEP is never read into memory, and the marker keeps the size of that descriptor
    const g = pathSafe.readFileGuarded(dir, file, { maxBytes: LOG_KEEP });
    if (!g.ok) {
      if (g.reason !== 'above-read-limit') return null;
      // the mtime is that of the opened descriptor the fstat was taken of; a file outside the window is foreign and silent
      const over = g.st;
      if (!over.isFile() || Number(over.mtimeMs) < s - WINDOW_SLACK_MS || Number(over.mtimeMs) > e + WINDOW_SLACK_MS) return null;
      return { oversize: true, bytes: g.size };
    }
    const st = g.st;
    if (!st.isFile() || Number(st.mtimeMs) < s - WINDOW_SLACK_MS || Number(st.mtimeMs) > e + WINDOW_SLACK_MS) return null;
    // The log is decoded through the shared strict decoder BEFORE any parsing: invalid UTF-8, a lone
    // surrogate, a BOM or NUL refuse, and the log is an admissible source that spoke and cannot name a model.
    // Every invisible or format character refuses it too (invisible:'refuse').
    const d = textSafe.decode(g.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
    if (!d.ok) return { unreadable: true, why: (d.problems[0] && d.problems[0].code) || 'refused' };
    return d.text;
  } catch { return null; }
}
function clientLogTexts(input) {
  const files = Array.isArray(input.logFiles) ? input.logFiles : [];
  const s = Date.parse(input.startedAt); const e = Date.parse(input.endedAt);
  return files.map(f => readClientLog(f, input.clientLogDir, s, e)).filter(t => t !== null);
}

function deriveServedModel(input = {}, env = process.env) {
  const client = String(input.client || '').toLowerCase();
  // The streams (and with them every client log file the caller names) are built ONLY in the branches that read
  // them. A client with no structured source (mimo, claude, kilo, any other) and the agy flag source read NO file and NO line at all.
  let streams = null; const streamsOfInput = () => (streams || (streams = streamsOf(input)));
  const none = (detail, reason) => ({ servedModel: null, source: 'none', confidence: 'none', match: 'unknown', detail, ...(reason ? { reason } : {}) });
  // The ONE gate of every candidate id, built once per derivation (the registry is read once, never per id). A refused id is
  // never printed, never compared and never stored (PROTO-DEC-0215 item 3); the gate runs FIRST, before any conflict comparison or detail.
  let listCache;
  const gate = id => {
    if (typeof id !== 'string' || !id) return false;
    if (listCache === undefined) listCache = clientAllowList(client, input);
    if (!listCache) return false;
    if (listCache.models.includes(id)) return true;
    return Object.keys(listCache.aliases).some(name => listCache.aliases[name] === id && listCache.models.includes(name));
  };
  // A caller that could not capture one of its own streams whole (its own read cap) names it in
  // input.unreadableStreams ('stdout', 'stderr', 'capturedOutput'). The derivation never judges a prefix of a stream.
  // Only a client whose proof READS that stream is bound by it - dahl reads stdout (or the capture), codex reads
  // stderr (and its logs); for vibe the export is the only source, so a strict and valid export WINS beside an unreadable stream.
  const unreadable = Array.isArray(input.unreadableStreams) ? input.unreadableStreams.filter(v => typeof v === 'string' && ['stdout', 'stderr', 'capturedOutput'].includes(v)) : [];
  // A stream that arrived as BYTES and was refused by the strict decode of the one entry point (or that arrived as a
  // pre-decoded string: its bytes are already lost) never reaches the parsers as text. Only a client whose proof
  // READS that stream is bound by the refusal (the rule above): dahl reads stdout - or the whole capture when the caller
  // gave no separate streams -, codex reads stderr; for vibe the export proves on its own. The refused stream is a source that SPOKE
  // and cannot name a model: it joins the combine as a negative source with its fixed reason, exactly as the table's malformed state
  // says (a proving source beside it is a conflict, and it never bypasses the comparison).
  const refusedStreams = Array.isArray(input.refusedStreams) ? input.refusedStreams.filter(v => typeof v === 'string' && ['stdout', 'stderr', 'capturedOutput'].includes(v)) : [];
  const apartNow = typeof input.stdout === 'string' || typeof input.stderr === 'string' || refusedStreams.includes('stdout') || refusedStreams.includes('stderr');
  const readsStream = name => (client === 'dahl' || client === 'openai-compat' ? (apartNow ? name === 'stdout' : name === 'capturedOutput') : client === 'codex' ? name === 'stderr' : false);
  const refusedBound = refusedStreams.filter(readsStream);
  const refusedProof = refusedBound.length
    ? { model: null, reason: 'unreadable client stream', detail: `the ${refusedBound.join(', ')} of this launch is not strict text (invalid UTF-8, a lone surrogate, a BOM, NUL, a lone CR or an invisible character) or arrived already decoded as text (its bytes are lost); the stream that holds the proof spoke and cannot name a model` }
    : null;
  const readsStreams = client === 'dahl' || client === 'openai-compat' || client === 'codex';
  if (unreadable.length && readsStreams) return none(`the caller could not read ${unreadable.join(', ')} whole (above the caller's read limit); no proof from a prefix`, 'stream above the read limit');
  let found = null; let source = 'none'; let confidence = 'none';
  try {
    if (client === 'dahl' || client === 'openai-compat') {
      // the structured result line of stdout, and the same line read at the end of each admissible client log file the caller named: they must agree
      const parts = [{ name: 'the AGENT_RESULT line of stdout', source: 'agent-result', confidence: 'exact', proof: refusedProof || fromAgentResult(streamsOfInput().out, gate) }];
      for (const [i, log] of streamsOfInput().logs.entries()) parts.push({ name: `the AGENT_RESULT line of client log ${i + 1}`, source: 'client-log', confidence: 'derived',
        // A log that is not strict text is an unreadable source beside the read limit (the shared decoder refused it)
        proof: typeof log === 'string' ? fromAgentResult(log, gate) : log.unreadable ? { model: null, reason: 'unreadable client log', detail: `client log ${i + 1} is not strict text (${log.why}: invalid UTF-8, a lone surrogate, a BOM or NUL); no proof` } : { model: null, reason: 'client log above the read limit', detail: `client log ${i + 1} is above the read limit (${log.bytes} bytes) and is not judged from a prefix; no proof` } });
      const chosen = combineProofs(parts);
      source = 'agent-result'; confidence = 'exact';
      if (chosen) { found = chosen.proof; if (chosen.source) { source = chosen.source; confidence = chosen.confidence; } }
    }
    else if (client === 'codex') {
      // the header block of the client's own streams; an admissible client log above the read limit is a source that spoke and
      // cannot name a model (never a head-and-tail prefix of it), and it contradicts a header that names one model
      const streams = streamsOfInput();
      const parts = [{ name: 'the codex header of the client streams', source: 'client-banner', confidence: 'exact', proof: refusedProof || fromCodexHeader(streams.own, gate) }];
      streams.logs.forEach((log, i) => { if (typeof log !== 'string') parts.push({ name: `client log ${i + 1}`, source: 'client-log', confidence: 'derived',
        // A log that is not strict text is an unreadable source beside the read limit
        proof: log.unreadable ? { model: null, reason: 'unreadable client log', detail: `client log ${i + 1} is not strict text (${log.why}: invalid UTF-8, a lone surrogate, a BOM or NUL); no proof` } : { model: null, reason: 'client log above the read limit', detail: `client log ${i + 1} is above the read limit (${log.bytes} bytes) and is not judged from a prefix; no proof` } }); });
      const chosen = combineProofs(parts);
      source = 'client-banner'; confidence = 'exact';
      if (chosen) { found = chosen.proof; if (chosen.source) { source = chosen.source; confidence = chosen.confidence; } }
    }
    else if (client === 'mimo') {
      // PROTO-DEC-0209: mimo has no structured proof source. The text log and the text banner are free text, and free text is not a proof source; no file
      // of the client is read and no line of its output is scanned for a model, whatever it holds and however well-formed the log looks.
      return none('mimo has no structured proof source (PROTO-DEC-0209): the text log and the text banner are not proof sources', 'no structured source');
    } else if (client === 'vibe') {
      // PROTO-DEC-0215 item 1: the served model is read ONLY from export.json of the launcher-fixed output directory the launcher
      // created and passed by --output-dir (input.exportDir). The session store, every printed session line and every client log file are NOT
      // proof sources any more: no stream and no log of the client is read at all, whatever it holds - a mixed log is "no structured source".
      found = fromVibeExport(input.exportDir);
      source = 'client-log'; confidence = 'derived';
    } else if (client === 'agy') {
      // PROTO-DEC-0209 item 1: the one structured source of agy is the explicit --model the launcher passed (requestedModelVia 'flag', a fact read from the
      // argv the client was really started with, never a claim). Any other way the model reached the client (not-passed, an environment alias) or nothing
      // said at all is no evidence: the record states what was asked through requestedModelVia, and nothing here guesses.
      if (input.requestedModelVia === 'flag') {
        // One model id of the closed grammar (an empty value, blanks or an invisible character inside the value name no model)
        const asked = modelIdOf(input.requestedModel);
        if (!asked) return none('agy was passed --model with a value that is not one model id of the closed grammar (empty, blanks or invisible characters); no proof', 'unknown launcher flag');
        found = { model: asked, detail: 'the --model flag the launcher passed to agy (requestedModelVia flag)' };
        source = 'launcher-model'; confidence = 'derived';
      } else return none(`no launcher-model evidence for agy (the model did not reach the client by flag; requestedModelVia ${input.requestedModelVia || 'unstated'})`);
    } else if (client === 'qwen') {
      // Qwen Code (PROTO-DEC-0211): the explicit model the launcher passed over the pinned route it made (source launcher-model); no file or output of the client is read
      return require('./qwen-client.cjs').derive({ requestedModel: input.requestedModel, requestedModelVia: 'flag', qwenRoute: input.qwenRoute, qwenClientFault: input.qwenClientFault }, none);
    } else return none(client ? `no structured source for client ${client}` : 'no client', 'no structured source');
  } catch { return none('derivation failed; no proof'); }
  if (found && !found.model) return none(found.detail, found.reason);
  if (!found) return none(`no ${source} evidence found for ${client}`);
  // PROTO-DEC-0215 item 3: the ONE allow-list gate every source passes through, the launcher's explicit model included. A refused id
  // (a placeholder, a secret-shaped value, anything the registry does not list) is never printed and never stored: the served model stays
  // unknown with the reason "model not in allow-list", and no mismatch text can name the value.
  if (!gate(found.model)) return none(`the proof names a model id that is not in the allow-list of client ${client} (.ai/docs/clients.json); the id is refused and not recorded`, 'model not in allow-list');
  // vibe: the requested value may be a name, the export holds an alias; both sides go through the alias table before they are compared
  const match = client === 'vibe' ? modelsMatch(vibeAlias(input.requestedModel, input.vibeModels).alias, vibeAlias(found.model, input.vibeModels).alias) : modelsMatch(input.requestedModel, found.model);
  return { servedModel: found.model, source, confidence, match, detail: found.detail };
}

// ---- The ONE derivation path of every caller ----
// deriveForLaunch(context) takes ONE context object built from the REAL spawned launch and returns requestedModelVia and the served-model proof
// TOGETHER: { servedModel, source, confidence, match, detail, reason?, requestedModelVia }. The context is a fact of the launch that really ran:
//   client           the client that was started
//   model            the explicit model the launcher asked for (the requested model of the record)
//   args             the REAL argv the client was started with (requestedModelVia is a fact of this argv, never a claim)
//   env              the environment the client was started with (the spawn environment, not this process's; the vibe alias route reads it)
//   exportDir        the launcher-fixed output directory the client wrote export.json into (vibe; PROTO-DEC-0215 item 1)
//   stdout, stderr, capturedOutput, logFiles, clientLogDir, startedAt, endedAt, workdir, logDir, unreadableStreams
//                    the stream and log bytes already read, with their provenance (see deriveServedModel)
//   vibeModels, allowModels, clientsFile   the alias mapping and the allow-list of the launch (the defaults are the shared ones)
//   qwenRoute, qwenClientFault   the qwen route proof of the run after it ended and its client fault (docs/ops/qwen-client.cjs afterRun/derive;
//                    PROTO-DEC-0211): an unproven route or an unclean run proves no served model
// requestedModelVia passed inside the context is never trusted: the value is computed here, from the argv and the spawn environment, through the
// ONE grammar of .ai/bin/launch-record.cjs (the record writer's own field), with the vibe alias mapping. deriveServedModel is private: this is the
// only exported derivation, so the same launch gives the same proof in every caller and no caller can hand the derivation a partial argument list.
// The stream fields of the context are BYTES - the Buffers the caller read from the spawn - and THIS
// function is the ONLY place they are decoded. A string is refused: its bytes are already lost (spawnSync with encoding utf8 turned a damaged
// byte into U+FFFD before the derivation could see it), so a stream that arrives as a string is an unreadable stream, never a proof. The
// shared text-safe decode runs on the WHOLE bytes: invalid UTF-8, a lone surrogate, a BOM, NUL, a lone CR and EVERY invisible or format
// character refuse the stream. The strict text of a stream that decoded is returned in decoded - the ONLY text a caller may show (display
// text is produced AFTER the check, never before) - and a refused stream is named in refusedStreams (a fixed name, never stream content).
function decodeStreamBytes(name, v, decoded, refusedStreams) {
  if (v === undefined || v === null) return;
  if (!Buffer.isBuffer(v) && !(v instanceof Uint8Array)) { refusedStreams.push(name); return; }
  const d = textSafe.decode(v, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (d.ok) decoded[name] = d.text; else refusedStreams.push(name);
}
function deriveForLaunch(context = {}, env = process.env) {
  const decoded = {}; const refusedStreams = [];
  decodeStreamBytes('capturedOutput', context.capturedOutput, decoded, refusedStreams);
  decodeStreamBytes('stdout', context.stdout, decoded, refusedStreams);
  decodeStreamBytes('stderr', context.stderr, decoded, refusedStreams);
  const via = launchRecordTool.requestedModelVia({
    client: context.client,
    args: context.args,
    env: context.env,
    model: context.model !== undefined ? context.model : context.requestedModel,
    aliasOf: name => vibeAlias(name, context.vibeModels).alias,
  });
  // qwen (PROTO-DEC-0211): the launcher always starts this client with -m, and its invocation may collapse the whole child command
  // line into one argv piece (the cmd.exe shim), where a separate -m value cannot be read back: the launcher states the fact, as for agy.
  const requestedVia = context.client === 'qwen' ? 'flag' : via;
  const served = deriveServedModel({
    client: context.client,
    requestedModel: context.model !== undefined ? context.model : context.requestedModel,
    requestedModelVia: requestedVia,
    capturedOutput: decoded.capturedOutput,
    stdout: decoded.stdout,
    stderr: decoded.stderr,
    refusedStreams,
    startedAt: context.startedAt,
    endedAt: context.endedAt,
    logDir: context.logDir,
    workdir: context.workdir,
    exportDir: context.exportDir,
    logFiles: context.logFiles,
    clientLogDir: context.clientLogDir,
    unreadableStreams: context.unreadableStreams,
    vibeModels: context.vibeModels,
    allowModels: context.allowModels,
    clientsFile: context.clientsFile,
    qwenRoute: context.qwenRoute,
    qwenClientFault: context.qwenClientFault,
    // kimi: the route the launcher prepared and the check made after the exit are facts of this launch, handed to the derivation by the same
    // entry point; every other client ignores them (the kimi block of deriveServedModel is guarded by the client name).
    kimiRoute: context.kimiRoute,
    kimiConfigCheck: context.kimiConfigCheck,
  }, env);
  // The record fields, the SERVED line and the note travel INSIDE the one return (recordFields, servedLine and
  // servedNote are private); decoded and refusedStreams give the caller the only text it may show, produced after the check.
  return {
    ...served,
    requestedModelVia: requestedVia,
    ...(Object.keys(decoded).length ? { decoded } : {}),
    ...(refusedStreams.length ? { refusedStreams } : {}),
    record: recordFields(served),
    line: servedLine(served),
    note: servedNote(served),
  };
}

// The three launch-record fields for a derivation result (servedModel is omitted when there is none).
function recordFields(result) {
  const out = { servedModelSource: result.source, servedModelConfidence: result.confidence };
  if (result.servedModel) out.servedModel = result.servedModel;
  return out;
}

function matchWord(match) { return match === true ? 'yes' : match === false ? 'no' : 'unknown'; }
function servedLine(result) { return `SERVED model=${result.servedModel || '-'} source=${result.source} match=${matchWord(result.match)}${result.reason ? ` reason="${result.reason}"` : ''}`; }
// The record note part for an unproven served model ('' when there is nothing to say).
function servedNote(result) { return result && result.reason ? `served-model-unproven reason="${result.reason}"` : ''; }
// A client without a row in the table of client shapes (SHAPES, defined where cells() is defined) has no cell table: cells(client) then refuses in words instead of
// failing on an undefined row. kimi is proven by the explicit model the launcher passed (kimi-served.cjs) and has no row. Where cells() and SHAPES do not exist this block does nothing.
if (typeof cells === 'function' && typeof SHAPES === 'object') {
  const cellsOf = cells;
  cells = function cells(clientName) {
    if (!Object.hasOwn(SHAPES, clientName)) throw new Error(`no served-model shape for client ${clientName} (SHAPES: ${Object.keys(SHAPES).join(', ')}); a client without a row is proven by its own launcher-side proof and has no cell table`);
    return cellsOf(clientName);
  };
}
// kimi (PROTO-DEC-0211): the served model of a kimi launch is the explicit model the launcher passed over the private subscription config it generated
// for the client (kimi-route.cjs, kimi-served.cjs, source launcher-model); no file of the client is read. The route sits HERE, after the table and the function, and not inside deriveServedModel: the lines
// inside the function are the lines that another change of this record edits (its unreadableStreams check comes first), so a block of its own merges with that change without a
// conflict. A caller that named an unreadable stream is handed to the function itself, whose own checks (where it has them) answer first.
{
  const deriveBase = deriveServedModel;
  deriveServedModel = function deriveServedModel(input = {}, env = process.env) {
    const named = !!input && Array.isArray(input.unreadableStreams) && input.unreadableStreams.length > 0;
    if (!named && String((input && input.client) || '').toLowerCase() === 'kimi') {
      const none = (detail, reason) => ({ servedModel: null, source: 'none', confidence: 'none', match: 'unknown', detail, ...(reason ? { reason } : {}) });
      return require('./kimi-served.cjs').derive(input, env, none);
    }
    return deriveBase(input, env);
  };
}

// The exported surface is CUT to what callers need - the ONE derivation path (deriveForLaunch), the allow-list gate
// (allowedModel), the alias and id helpers the launchers and the proof consumers call before and beside the derivation (vibeAlias for the
// VIBE_ACTIVE_MODEL alias of a vibe launch, built before the spawn; modelsMatch for the envelope proof of client-proof and the rating,
// selection and seat checks; matchWord for the SERVED word of seat-check), and the data constants. Everything else - deriveServedModel,
// fromAgentResult, fromCodexHeader, fromVibeExport, jsonEventStream, clientAllowList, streamsOf, parseJsonAll, readClientLog, decide,
// outcomeOf, recordFields, servedLine and servedNote - is PRIVATE: no caller can reach a partial derivation any more, and the record fields,
// the SERVED line and the note travel inside the one return of deriveForLaunch.
// PROTO-DEC-0239 item 4: expose the table enumerator for the Kimi integration check.
module.exports = { cells, deriveForLaunch, allowedModel, vibeAlias, modelsMatch, matchWord, VIBE_MODELS, SOURCES, CONFIDENCE, VIBE_EXPORT_FILE, VIBE_EXPORT_MODEL_PATH, TABLE, SHAPES, DEVIATIONS, NOT_APPLICABLE };
