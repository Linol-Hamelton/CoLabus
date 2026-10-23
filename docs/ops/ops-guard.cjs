'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decode, parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const paths = require('../../.ai/bin/lib/path-safe.cjs');
const numbers = require('../../tools/operator/closed-number.cjs');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const ownerIdentity = require('../../.ai/bin/lib/owner-identity.cjs');
const refuse = code => { throw new Error(code); };
const STREAM = /^[a-z0-9][a-z0-9-]{0,127}$/;

function safeMachineId(raw) {
  return ownerIdentity.safeMachineId(raw);
}

function parseOwner(rawOwner, explicitMachine = null) {
  return ownerIdentity.parseOwnerIdentity(rawOwner, explicitMachine);
}
const sameOwner = (a,b) => a.namespaced === b.namespaced;

const STATUSES = ['building', 'ready', 'certifying', 'certified', 'landed', 'retired', 'void', 'superseded'];
const LIVE = new Set(['building', 'ready', 'certifying', 'certified']);
const DEAD = new Set(['void', 'superseded']);

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim() };
}
function mainRoot(repo) {
  return repoPaths.mainRoot(repo);
}
// Every ref the gate resolves is fully qualified: a bare name lets a tag of the
// same name shadow the branch. The name is matched exactly (case included), so a
// case-folding file system cannot resolve a different spelling to the branch.
function branchTip(repo, branch) {
  const ref = `refs/heads/${branch}`;
  const r = git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', ref]);
  if (r.code !== 0) return null;
  for (const line of r.out.split('\n')) {
    const [name, id] = line.trim().split(' ');
    if (name === ref && /^[0-9a-f]{40}$/.test(id)) return id;
  }
  return null;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tips') o.tips = true;
    else if (['--file', '--claims', '--repo', '--now', '--stream', '--owner', '--worktree', '--ttl', '--register', '--machine', '--preferred'].includes(a)) {
      if (i + 1 >= argv.length || argv[i+1].startsWith('--') || Object.hasOwn(o,a.slice(2))) return { error:'missing or duplicate option value' };
      o[a.slice(2)] = argv[++i];
    }
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

function readRegistry(file) {
  if (!fs.existsSync(file)) throw new Error(`registry not found: ${file} (create it from docs/ops/CANDIDATES-TEMPLATE.md)`);
  const {parseRegistry}=require('../../.ai/bin/lib/candidate-registry.cjs');
  try {
    const parsed=parseRegistry(fs.readFileSync(file));
    return {rows:parsed.rows.map(({index,cells})=>{
      const [stream,branch,sha,owner,status,updated,note]=cells;
      return {line:index+1,stream,branch,sha,owner,status,updated,note};
    }),problems:[]};
  } catch(error) {
    if(error.code!=='invalid-registry')throw error;
    return {rows:[],problems:[error.reason ? `invalid-registry: ${error.reason} (line ${error.line})` : 'invalid-registry']};
  }
}

function currentOf(rows, stream) {
  const live = rows.filter(r => r.stream === stream && LIVE.has(r.status));
  return { live, current: live[live.length - 1] || null };
}

function validate(file, repo, tips, launchStream = null) {
  const { rows, problems } = readRegistry(file);
  const warnings = [];
  const streams = [...new Set(rows.map(r => r.stream))];
  for (const s of streams) {
    const { live } = currentOf(rows, s);
    if (live.length > 1) problems.push(`stream "${s}" has ${live.length} live candidates (${live.map(r => r.branch + '@' + r.sha).join(', ')}); mark all but one void or superseded`);
    if (s.startsWith('desk-')) {
      const base = s.slice(5);
      if (streams.includes(base)) {
        const liveDesk = currentOf(rows, s).current;
        const liveBase = currentOf(rows, base).current;
        if (liveDesk && liveBase) {
          problems.push(`cross-machine stream collision: desktop stream "${s}" and laptop stream "${base}" are both live candidates (${liveDesk.branch}@${liveDesk.sha} vs ${liveBase.branch}@${liveBase.sha})`);
        }
      }
    }
  }
  for (const r of rows) {
    if (git(repo, ['cat-file', '-e', `${r.sha}^{commit}`]).code !== 0) problems.push(`line ${r.line}: ${r.sha} is not a commit of this repository`);
    // A full candidate SHA in the branch column denotes a detached candidate.
    // Peeling a tag or resolving a SHA-shaped ref must not substitute a commit.
    // Every other value remains an exact refs/heads name, never a committish.
    if (r.branch === r.sha) {
      const commit = git(repo, ['rev-parse', '--verify', `${r.sha}^{commit}`]);
      if (commit.code !== 0 || commit.out !== r.sha) problems.push(`line ${r.line}: ${r.sha} is not the exact detached commit`);
    }
    if (tips && LIVE.has(r.status) && r.branch !== r.sha) {
      const tip = branchTip(repo, r.branch);
      if (tip === null) problems.push(`line ${r.line}: branch "${r.branch}" does not exist`);
      else if (tip !== r.sha) {
        const message = `line ${r.line}: STALE - ${r.branch} is at ${tip.slice(0, 9)}, the registry says ${r.sha}; update the row (and re-pin launchers)`;
        // A launch depends on its stream's tip. Other streams may be building;
        // structural errors remain global, and candidates --tips stays strict.
        if (launchStream !== null && r.stream !== launchStream) warnings.push(message);
        else problems.push(message);
      }
    }
  }
  return { rows, problems, streams, warnings };
}

// Compatibility letters/digits (including mathematical alphabets) are handled by
// NFKD. These explicit visual folds cover Cyrillic/Greek ASCII lookalikes; this
// is a pin policy, not transliteration of arbitrary prose.
const PIN_FOLDS = new Map();
for (const [ascii, glyphs] of Object.entries({
  a: '\u0410\u0430\u0391\u03b1', b: '\u0412\u0432\u0392\u03b2\u042c\u044c',
  c: '\u0421\u0441\u03f9\u03f2', d: '\u0500\u0501', e: '\u0415\u0435\u0395\u03b5\u03f5',
  f: '\u03dc\u03dd', g: '\u050c\u050d', h: '\u041d\u043d\u0397\u04ba\u04bb',
  i: '\u0406\u0456\u0399\u03b9\u04c0\u04cf', j: '\u0408\u0458\u03f3',
  k: '\u041a\u043a\u039a\u03ba\u03f0', l: '\u04c6', m: '\u041c\u043c\u039c\u03bc',
  n: '\u039d\u03bd', o: '\u041e\u043e\u039f\u03bf', p: '\u0420\u0440\u03a1\u03c1\u03f1',
  s: '\u0405\u0455', t: '\u0422\u0442\u03a4\u03c4', u: '\u03a5\u03c5',
  v: '\u0474\u0475', x: '\u0425\u0445\u03a7\u03c7', y: '\u0423\u0443\u04ae\u04af\u03b3',
  z: '\u0396\u03b6',
})) for (const glyph of glyphs) PIN_FOLDS.set(glyph.normalize('NFKD').replace(/\p{M}/gu, ''), ascii);
const PIN_SHA_PREFIX = 10; // At most two unknown glyphs: at least eight exact hex positions.
// Derived Unicode separator families, including sequences and non-ASCII representatives.
const PIN_SEPARATORS = new Map();
for (const [codePoint, codePoints] of Object.entries(require('./lib/pin-separators.json').characters)) {
  const glyph = String.fromCodePoint(parseInt(codePoint.slice(2), 16));
  const separator = String.fromCodePoint(...codePoints);
  for (const form of [glyph, glyph.toLowerCase(), glyph.toUpperCase()]) PIN_SEPARATORS.set(form, separator);
}
// PROTO-DEC-0210: refuse markup and references; never model HTML rendering.
// The 106 case-sensitive WHATWG legacy names are prefix matches, even before
// letters/digits/equals. All semicolon-terminated names (including unknown ones)
// and every numeric-reference opener refuse. Plain symbols such as R&D pass.
const PIN_HTML = /<[A-Za-z/!?]|&(?:#|[A-Za-z][A-Za-z0-9]*;|AElig|AMP|Aacute|Acirc|Agrave|Aring|Atilde|Auml|COPY|Ccedil|ETH|Eacute|Ecirc|Egrave|Euml|GT|Iacute|Icirc|Igrave|Iuml|LT|Ntilde|Oacute|Ocirc|Ograve|Oslash|Otilde|Ouml|QUOT|REG|THORN|Uacute|Ucirc|Ugrave|Uuml|Yacute|aacute|acirc|acute|aelig|agrave|amp|aring|atilde|auml|brvbar|ccedil|cedil|cent|copy|curren|deg|divide|eacute|ecirc|egrave|eth|euml|frac12|frac14|frac34|gt|iacute|icirc|iexcl|igrave|iquest|iuml|laquo|lt|macr|micro|middot|nbsp|not|ntilde|oacute|ocirc|ograve|ordf|ordm|oslash|otilde|ouml|para|plusmn|pound|quot|raquo|reg|sect|shy|sup1|sup2|sup3|szlig|thorn|times|uacute|ucirc|ugrave|uml|uuml|yacute|yen|yuml)/;
function pinHtmlRefused(text) { return PIN_HTML.test(text); }
function pinDecode(text) {
  // Keep the bounded, pre-existing percent/Markdown decoding policy. No HTML
  // character is decoded. A caller must refuse HTML in raw and decoded text.
  for (let round = 0; round <= 8; round++) {
    const next = text.replace(/%([0-9a-fA-F]{2})/g, (ref, hex) => {
      const c = String.fromCharCode(parseInt(hex, 16));
      return /^[0-9A-Za-z./_-]$/.test(c) ? c : ref;
    }).replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1').replace(/[*`]/g, '');
    if (next === text) return text;
    if (round === 8) return null;
    text = next;
  }
}
function pinViews(text) {
  const source = pinDecode(text);
  if (source === null) return null;
  // Exactly one Markdown policy beside the decoded source: remove link/image
  // syntax and destinations/definitions, retaining label text. The source view
  // retains destinations. Emphasis, code markers and escapes decode above.
  return [{ name: 'source', text: source },
    { name: 'markdown', text: pinStripMarkdown(source) }];
}
function pinStripMarkdown(text) {
  // Pair delimiters once. A malformed annotation stays plain text and cannot
  // stop later valid links; even repeated unclosed constructs take linear work.
  text = text.replace(/^ {0,3}\[([^\]\n]+)\]:([^\n]*)(?:\n|$)/gm,
    '');
  const pairs = new Map(), brackets = [], parentheses = [];
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (c === '[') brackets.push(at);
    else if (c === '(') parentheses.push(at);
    else if (c === ']' && brackets.length) pairs.set(brackets.pop(), at);
    else if (c === ')' && parentheses.length) pairs.set(parentheses.pop(), at);
  }
  const pieces = [];
  let keep = 0;
  for (let at = 0; at < text.length; at++) {
    if (text[at] !== '[') continue;
    const labelEnd = pairs.get(at);
    if (labelEnd === undefined || !['(', '['].includes(text[labelEnd + 1])) continue;
    const end = pairs.get(labelEnd + 1);
    if (end === undefined) continue;
    const start = at > keep && text[at - 1] === '!' ? at - 1 : at;
    pieces.push(text.slice(keep, start), text.slice(at + 1, labelEnd));
    keep = end + 1;
    at = end;
  }
  return pieces.join('') + text.slice(keep);
}
function pinSkeleton(text) {
  // Fold separators before decomposition and wildcard classification, keeping
  // name and text positions aligned even for symbol/letter-category lookalikes.
  text = [...text].map(c => PIN_SEPARATORS.get(c) || c).join('');
  const decomposed = text.normalize('NFKD').replace(/\p{M}/gu, '');
  return [...decomposed].map(c => PIN_FOLDS.get(c) || c).join('').toLowerCase()
    .replace(/[^0-9a-z]/gu, c => /[\p{L}\p{N}\p{S}]/u.test(c) ? '?' : '');
}
function pinSkeletonMatches(text, name) {
  const matches = [];
  if (!name) return matches;
  for (let at = 0; at <= text.length - name.length; at++) {
    let unknown = 0;
    let exact = 0;
    for (let i = 0; i < name.length; i++) {
      const c = text[at + i];
      if (c === '?') unknown++;
      else if (c === name[i]) exact++;
      else break;
    }
    if (unknown <= 2 && exact + unknown === name.length) matches.push({ start: at, end: at + name.length, length: name.length });
  }
  return matches;
}
function pinMatches(text, name, length = name.length) {
  const matches = [];
  if (!name) return matches;
  for (let at = text.indexOf(name); at !== -1; at = text.indexOf(name, at + 1)) {
    matches.push({ start: at, end: at + name.length, length });
  }
  return matches;
}
// A proper longer live name shelters only the void occurrences it contains.
// Equal skeletons are ambiguous and refuse. Keep all occurrences, including overlaps.
function pinUnsheltered(dead, live) {
  return dead.some(d => !live.some(l => l.length > d.length && l.start <= d.start && l.end >= d.end));
}
function pinBranchTokenHit(tokens, branch, current) {
  const deadName = `/${branch.toLowerCase()}/`;
  const liveName = `/${current.toLowerCase()}/`;
  return tokens.some(t => {
    const live = pinMatches(t, liveName);
    // A path under the live branch belongs to that branch. Its actual name
    // length still governs precedence: cand/old outranks cand, x loses to cand-new/x.
    for (const l of live) l.end = t.length;
    return pinUnsheltered(pinMatches(t, deadName), live);
  });
}

function pinCheck(rows, stream, files) {
  const { current } = currentOf(rows, stream);
  const problems = [];
  if (!current) return { problems: [`stream "${stream}" has no live candidate`], warnings: [] };
  const others = rows.filter(r => r.stream === stream && r !== current);
  const warnings = [];
  for (const f of files) {
    let bytes;
    try {
      if (!fs.statSync(f).isFile()) { problems.push(`${f}: PIN_NOT_FILE; expected a regular pin file`); continue; }
      bytes = fs.readFileSync(f);
    } catch (error) {
      problems.push(`${f}: PIN_READ_REFUSED (${error.code || 'IO_ERROR'}); cannot read pin file`);
      continue;
    }
    // The pinned file is read as bytes through the shared text-safe reader: a BOM, bytes that are not
    // UTF-8 (UTF-16 included), and text-safe's enumerated invisibles refuse the file.
    const decoded = decode(bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
    const format = decoded.ok && /\p{Cf}/u.exec(decoded.text);
    if (!decoded.ok || format) {
      const why = decoded.ok ? `FORMAT_CHARACTER U+${format[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`
        : decoded.problems.slice(0, 3).map(p => `${p.code}${p.detail ? ` ${p.detail}` : ''}${p.line ? ` at line ${p.line}` : ''}`).join('; ');
      problems.push(`${f}: cannot be pin-checked, refused as text (${why}); write the SHA and the branch plainly`);
      continue;
    }
    // Refuse the whole file, even without a historical row or a hidden pin.
    if (pinHtmlRefused(decoded.text)) { problems.push(`${f}: PIN_HTML_REFUSED; HTML markup or character reference is forbidden`); continue; }
    const views = pinViews(decoded.text);
    if (views === null) { problems.push(`${f}: PIN_DECODE_DEPTH; write pins plainly`); continue; }
    if (views.some(view => pinHtmlRefused(view.text))) { problems.push(`${f}: PIN_HTML_REFUSED; decoded HTML markup or character reference is forbidden`); continue; }
    // Compatibility forms (full-width hex) fold to ASCII; tokens are whole runs, never a scan inside a word.
    const text = decoded.text.normalize('NFKC');
    // A SHA token is a whole word of 7 or more hex digits in either case, compared lower-case: a
    // shorter token is not a SHA; an abbreviation, or a longer token that starts
    // with a registered SHA, still names it.
    const tokens = new Set(text.split(/[^0-9A-Za-z_]+/).filter(t => /^[0-9a-fA-F]{7,}$/.test(t)).map(t => t.toLowerCase()));
    // A branch token is a whole run of ref characters with the punctuation around it cut off; it names
    // a branch when the branch is the token or a whole path segment sequence of it, in any letter case.
    const branchTokens = text.split(/[^0-9A-Za-z._\/-]+/).map(t => `/${t.replace(/^[./-]+|[./-]+$/g, '').toLowerCase()}/`);
    // Any view may refuse. Deduplicate only equivalent final skeletons.
    const skeletons = [...new Set(views.map(view => pinSkeleton(view.text)))];
    for (const o of others) {
      const hit = [...tokens].some(t => t.startsWith(o.sha) || o.sha.startsWith(t));
      const shaSkeletonHit = skeletons.some(skeleton => pinUnsheltered(pinSkeletonMatches(skeleton, pinSkeleton(o.sha).slice(0, PIN_SHA_PREFIX)), pinSkeletonMatches(skeleton, pinSkeleton(current.sha))));
      if ((hit || shaSkeletonHit) && o.sha !== current.sha) problems.push(`${f}: names ${o.sha} (${o.branch}, ${o.status}), not the live candidate ${current.sha}`);
      const name = pinSkeleton(o.branch);
      const branchHit = pinBranchTokenHit(branchTokens, o.branch, current.branch);
      const branchSkeletonHit = name.length >= 6 && skeletons.some(skeleton => pinUnsheltered(pinSkeletonMatches(skeleton, name), pinSkeletonMatches(skeleton, pinSkeleton(current.branch))));
      if (o.branch.toLowerCase() !== current.branch.toLowerCase() && (branchHit || branchSkeletonHit)) problems.push(`${f}: names branch "${o.branch}" (${o.status}), the live branch is "${current.branch}"`);
    }
    if (![...tokens].some(t => t.startsWith(current.sha) || current.sha.startsWith(t))) warnings.push(`${f}: does not name the live candidate ${current.sha}`);
  }
  return { problems, warnings, current };
}

function readClaims(file) {
  const guard = paths.realInside(path.parse(file).root,file,{refuseHardlinks:true});
  if (!guard.ok) refuse('CLAIMS_PATH_REFUSED');
  if (!guard.exists) return [];
  const read = paths.readFileGuarded(path.parse(file).root,file);
  if (!read.ok) refuse('CLAIMS_READ_REFUSED');
  const decoded = decode(read.bytes,{bom:'strip',crlf:'normalise',invisible:'refuse'});
  if (!decoded.ok) refuse('CLAIMS_TEXT_REFUSED');
  const c = parseJsonUnique(decoded.text);
  if (!c || Array.isArray(c) || typeof c !== 'object' || !Array.isArray(c.claims) || Object.keys(c).some(k=>k!=='claims')) refuse('CLAIMS_SCHEMA');
  const streams = new Set();
  for (const row of c.claims) {
    if (!row || typeof row !== 'object' || typeof row.stream !== 'string' || !STREAM.test(row.stream) || streams.has(row.stream)) refuse('CLAIMS_SCHEMA');
    streams.add(row.stream);
    const identity = parseOwner(row.owner,row.machine);
    if (row.namespacedOwner !== undefined && row.namespacedOwner !== identity.namespaced) refuse('CLAIMS_IDENTITY');
    if (typeof row.since !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.since) || !Number.isFinite(Date.parse(row.since))
        || !Number.isSafeInteger(row.ttlMin) || row.ttlMin < 1 || row.ttlMin > 525600
        || (row.worktree !== undefined && row.worktree !== null && (typeof row.worktree !== 'string' || !path.isAbsolute(row.worktree)))) refuse('CLAIMS_SCHEMA');
  }
  return c.claims;
}
function writeClaims(file, claims) {
  const written = paths.writeAtomicGuarded(file,Buffer.from(JSON.stringify({claims},null,2)+'\n'),{root:path.dirname(file)});
  if (!written.ok) refuse('CLAIMS_WRITE_REFUSED');
}
function withClaimsTransaction(file, action) {
  const parent = path.dirname(file);
  const guard = paths.realInside(path.parse(file).root,file,{refuseHardlinks:true});
  if (!guard.ok) refuse('CLAIMS_PATH_REFUSED');
  fs.mkdirSync(parent,{recursive:true});
  const result = paths.withDirectoryPinned(parent,() => {
    const lock = `${file}.lock`;
    const check = paths.realInside(path.parse(file).root,lock,{refuseHardlinks:true});
    if (!check.ok || check.exists) return {ok:false,reason:'CLAIMS_BUSY'};
    let fd;
    try { fd = fs.openSync(lock,'wx'); } catch { return {ok:false,reason:'CLAIMS_BUSY'}; }
    try { return {ok:true,fd,id:fs.fstatSync(fd,{bigint:true}),lock}; }
    catch {
      try { fs.closeSync(fd); } finally { fs.unlinkSync(lock); }
      return {ok:false,reason:'CLAIMS_TRANSACTION_REFUSED'};
    }
  });
  if (!result.ok) refuse(result.reason || 'CLAIMS_TRANSACTION_REFUSED');
  // The open lock file retains the parent chain pin on Windows. Do not retain
  // an exclusive directory handle during atomic publication (NTFS rename).
  try { return action(); }
  finally {
    // Always release the descriptor before another filesystem operation,
    // including guards that may throw when the lock disappears.
    fs.closeSync(result.fd);
    let matches = false;
    try {
      const post = paths.realInside(path.parse(file).root,result.lock,{refuseHardlinks:true});
      if (post.ok && post.exists) {
        const id = fs.lstatSync(result.lock,{bigint:true});
        matches = id.ino === result.id.ino && id.dev === result.id.dev;
      }
    } catch { refuse('CLAIMS_LOCK_CHANGED'); }
    if (!matches) refuse('CLAIMS_LOCK_CHANGED');
    fs.unlinkSync(result.lock);
  }
}
const alive = (c, now) => Date.parse(c.since) + c.ttlMin * 60000 > now;

const REGISTER_STATUSES = ['implemented', 'partial', 'proposed', 'retired'];
const PATH_PATTERN = /(?:docs|\.ai|\.kilo|tests)\/[A-Za-z0-9._\/-]+\.(?:md|cjs|json)/g;
// The register of operating processes (docs/ops/PROCESS-REGISTER.md): one row per process, so a process that was built is not forgotten.
function checkRegister(file, rootOrRoots) {
  const roots = [].concat(rootOrRoots);
  if (!fs.existsSync(file)) throw new Error(`register not found: ${file}`);
  const problems = [];
  const idLines = new Map();
  let rows = 0;
  numbers.classifyProcessRows(fs.readFileSync(file)).forEach(row => {
    if (row.kind === 'non-row') return;
    rows++;
    if (row.kind === 'refused' && row.line.trim().replace(/^\||\|$/g, '').split('|').length !== 9) {
      problems.push(`line ${row.lineNumber}: ${row.reason}: needs 9 columns (id | process | since | trigger | command | documented in | owner | enforced by | status)`); return;
    }
    if (row.kind === 'refused') { problems.push(`line ${row.lineNumber}: ${row.reason}`); return; }
    const t = row.line.trim(); const i = row.lineNumber - 1;
    const c = t.replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    if (c.length < 9) { problems.push(`line ${i + 1}: needs 9 columns (id | process | since | trigger | command | documented in | owner | enforced by | status)`); return; }
    const [id, name, since, trigger, command, doc, owner, enforced, status] = c;
    try { numbers.closedProcessNumber(id); }
    catch { problems.push(`line ${i + 1}: INVALID_PROCESS_NUMBER ${id}`); return; }
    if (idLines.has(id)) {
      problems.push(`line ${i + 1}: DUPLICATE_ID ${id} (first at line ${idLines.get(id)})`);
    } else {
      idLines.set(id, i + 1);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) problems.push(`line ${i + 1}: ${id} since "${since}" is not YYYY-MM-DD`);
    for (const [k, v] of Object.entries({ name, trigger, command, doc, owner, enforced })) if (!v) problems.push(`line ${i + 1}: ${id} ${k} is empty`);
    if (!REGISTER_STATUSES.includes(status)) problems.push(`line ${i + 1}: ${id} status "${status}" is not one of ${REGISTER_STATUSES.join(', ')}`);
    if (status === 'implemented' || status === 'partial') {
      for (const p of new Set(`${command} ${doc}`.match(PATH_PATTERN) || [])) {
        if (!roots.some(r => fs.existsSync(path.join(r, p)))) problems.push(`line ${i + 1}: ${id} names ${p}, which does not exist`);
      }
    }
  });
  return { rows, problems };
}

function main(argv) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  if (!cmd || o.error) { process.stderr.write(`${o.error || 'usage: ops-guard.cjs candidates|pin-check|claim|release|status|launch-gate [options]'}\n`); return 2; }
  const repo = path.resolve(o.repo || process.cwd());
  const root = mainRoot(repo);
  const registry = path.resolve(o.file || path.join(root, '.ai', 'runtime', 'CANDIDATES.md'));
  const claimsFile = path.resolve(o.claims || path.join(path.dirname(registry), 'claims.json'));
  const now = o.now ? Date.parse(o.now) : Date.now();
  if (Number.isNaN(now)) { process.stderr.write('--now must be an ISO time\n'); return 2; }
  const say = s => process.stdout.write(`${s}\n`);

  try {
    if (cmd === 'candidates') {
      const v = validate(registry, repo, o.tips);
      for (const s of v.streams) { const c = currentOf(v.rows, s).current; say(`stream ${s}: ${c ? `${c.branch} @ ${c.sha} (${c.status}, owner ${c.owner})` : 'no live candidate'}`); }
      v.problems.forEach(p => say(`PROBLEM ${p}`));
      say(`RESULT exit=${v.problems.length ? 1 : 0} streams=${v.streams.length} rows=${v.rows.length} problems=${v.problems.length}`);
      return v.problems.length ? 1 : 0;
    }
    if (cmd === 'register') {
      // Files a row names are looked for in the checkout being checked AND in the main checkout: in a linked worktree a new row
      // names new files that exist only there until the branch lands, while untracked runtime files (.ai/runtime/...) exist only in
      // the main checkout (otherwise `register` fails on every unlanded branch).
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      const base = top.code === 0 && top.out ? path.resolve(top.out) : root;
      const file = path.resolve(o.register || path.join(base, 'docs', 'ops', 'PROCESS-REGISTER.md'));
      const r = checkRegister(file, [...new Set([base, root])]);
      r.problems.forEach(p => say(`PROBLEM ${p}`));
      say(`RESULT exit=${r.problems.length ? 1 : 0} processes=${r.rows} problems=${r.problems.length}`);
      return r.problems.length ? 1 : 0;
    }
    if (cmd === 'pin-check') {
      if (!o.stream || !o._.length) { process.stderr.write('pin-check needs --stream and at least one file\n'); return 2; }
      const { rows, problems: reg, warnings: regWarnings } = validate(registry, repo, o.tips, o.stream);
      const r = pinCheck(rows, o.stream, o._);
      [...reg, ...r.problems].forEach(p => say(`PROBLEM ${p}`));
      [...regWarnings, ...r.warnings].forEach(w => say(`WARN ${w}`));
      say(`RESULT exit=${reg.length + r.problems.length ? 1 : 0} files=${o._.length}`);
      return reg.length + r.problems.length ? 1 : 0;
    }
    if (cmd === 'claim' || cmd === 'release') {
      if (!o.stream || !o.owner) { process.stderr.write(`${cmd} needs --stream and --owner\n`); return 2; }
      if (!STREAM.test(o.stream)) refuse('INVALID_STREAM');
      const parsed = parseOwner(o.owner,o.machine);
      const requestedTree = o.worktree ? fs.realpathSync.native(path.resolve(o.worktree)) : null;
      if (requestedTree && !fs.statSync(requestedTree).isDirectory()) refuse('INVALID_WORKTREE');
      return withClaimsTransaction(claimsFile,() => {
      const all = readClaims(claimsFile);
      const live = all.filter(c => alive(c, now));
      if (cmd === 'release') {
        const next = all.filter(c => c.stream !== o.stream || !sameOwner(parseOwner(c.owner,c.machine),parsed));
        writeClaims(claimsFile, next.filter(c => alive(c, now)));
        say(`RESULT exit=0 released=${all.length - next.length}`);
        return 0;
      }
      // Cross-machine collision check: desk operates on desk-* streams/branches.
      // Laptop claims cannot collide with an existing desktop branch desk-<stream>.
      // Desk claims cannot collide with an existing laptop branch <stream>.
      const baseStream = o.stream.replace(/^desk-/, '');
      if (!baseStream || (parsed.machine === 'desk' && !o.stream.startsWith('desk-'))) refuse('DESK_STREAM_PREFIX_REQUIRED');
      const branches = git(repo,['for-each-ref','--format=%(refname:lstrip=2)','refs/heads/']);
      if (branches.code !== 0) refuse('BRANCHES_UNKNOWN');
      const opposite = o.stream.startsWith('desk-') ? baseStream : `desk-${baseStream}`;
      if (branches.out.split('\n').includes(opposite)) {
        say(`REFUSED stream ${o.stream} collides with branch ${opposite}`);
        say('RESULT exit=1'); return 1;
      }
      const clash = live.find(c => {
        const cOwner = parseOwner(c.owner, c.machine);
        if (sameOwner(cOwner,parsed)) return false;
        return c.stream.replace(/^desk-/,'') === baseStream
          || (requestedTree && c.worktree && paths.sameFileOrNested(requestedTree,c.worktree));
      });
      if (clash) {
        const clashOwner = clash.namespacedOwner || (clash.machine ? `${clash.machine}/${clash.owner}` : clash.owner);
        say(`REFUSED stream ${clash.stream} / worktree ${clash.worktree || '-'} is claimed by ${clashOwner} since ${clash.since} (ttl ${clash.ttlMin} min); wait, ask the owner, or let the claim expire`);
        say('RESULT exit=1');
        return 1;
      }
      const ttl = o.ttl === undefined ? 120 : numbers.closedInteger(o.ttl,'INVALID_TTL');
      if (ttl < 1 || ttl > 525600) { process.stderr.write('--ttl must be a positive integer (minutes)\n'); return 2; }
      const kept = live.filter(c => {
        if (c.stream !== o.stream) return true;
        const cOwner = parseOwner(c.owner, c.machine);
        return !sameOwner(cOwner,parsed);
      });
      kept.push({ stream: o.stream, owner: parsed.owner, machine: parsed.machine, namespacedOwner: parsed.namespaced, worktree: requestedTree, since: new Date(now).toISOString(), ttlMin: ttl });
      writeClaims(claimsFile, kept);
      say(`RESULT exit=0 claimed stream=${o.stream} owner=${parsed.namespaced} machine=${parsed.machine || '-'} ttl=${ttl}`);
      return 0;
      });
    }
    if (cmd === 'status') {
      const claims = readClaims(claimsFile);
      if (!claims.length) say('no claims');
      for (const c of claims) {
        const oName = c.namespacedOwner || (c.machine ? `${c.machine}/${c.owner}` : c.owner);
        say(`${alive(c, now) ? 'LIVE   ' : 'EXPIRED'} stream=${c.stream} owner=${oName}${c.machine ? ` machine=${c.machine}` : ''} worktree=${c.worktree || '-'} since=${c.since} ttl=${c.ttlMin}`);
      }
      say('RESULT exit=0');
      return 0;
    }
    if (cmd === 'launch-gate') {
      if (!o.stream || !o.owner || !o._.length) { process.stderr.write('launch-gate needs --stream, --owner and at least one launcher or prompt file\n'); return 2; }
      const v = validate(registry, repo, true, o.stream);
      const problems = [...v.problems];
      const claim = readClaims(claimsFile).find(c => alive(c, now) && c.stream === o.stream);
      const parsedReq = parseOwner(o.owner,o.machine);
      if (!claim) {
        // Preserve explicit fixture/installed paths in the recovery instruction.
        const recovery = ['--stream', o.stream,
          '--owner', o.owner, ...(o.machine ? ['--machine', o.machine] : []),
          '--repo', repo, '--file', registry, '--claims', claimsFile,
          ...(o.now ? ['--now', o.now] : [])];
        const command = 'node docs/ops/ops-guard.cjs claim ' + recovery.map(arg => JSON.stringify(arg.replace(/\\/g, '/'))).join(' ');
        problems.push(`no live claim on stream "${o.stream}": run ${command}, then retry launch-gate`);
      }
      else {
        const claimOwner = parseOwner(claim.owner, claim.machine);
        const matchOwner = sameOwner(claimOwner,parsedReq);
        if (!matchOwner) problems.push(`stream "${o.stream}" is claimed by ${claim.namespacedOwner || (claim.machine ? `${claim.machine}/${claim.owner}` : claim.owner)}, not ${parsedReq.namespaced}`);
      }
      const p = pinCheck(v.rows, o.stream, o._);
      problems.push(...p.problems);
      problems.forEach(x => say(`PROBLEM ${x}`));
      [...v.warnings, ...p.warnings].forEach(w => say(`WARN ${w}`));
      say(`RESULT exit=${problems.length ? 1 : 0} stream=${o.stream} candidate=${p.current ? `${p.current.branch}@${p.current.sha}` : 'none'}`);
      return problems.length ? 1 : 0;
    }
    if (cmd === 'next-number' || cmd === 'allocate-number') {
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      const base = top.code === 0 && top.out ? path.resolve(top.out) : root;
      const file = path.resolve(o.register || path.join(base, 'docs', 'ops', 'PROCESS-REGISTER.md'));
      if (!fs.existsSync(file)) { process.stderr.write(`register not found: ${file}\n`); return 2; }
      const content = fs.readFileSync(file, 'utf8');
      const cn = numbers;
      const preferred = o.preferred !== undefined ? o.preferred : null;
      const next = preferred !== null ? cn.allocateProcessNumber(content, preferred) : cn.nextProcessNumber(content);
      const formatted = cn.formatProcessNumber(next);
      say(`NEXT_NUMBER ${formatted}`);
      say(`RESULT exit=0 next=${formatted} number=${next}`);
      return 0;
    }
    process.stderr.write(`unknown command ${cmd}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
}

// Retirement owns this transition; exact branch+SHA prevents a stale cleanup
// from retiring a newer candidate. The existing claims transaction serializes
// this with stream claims, and atomic guarded IO rejects links and path swaps.
function transitionLandedRows(file, expected, target) {
  if (target === 'landed') {
    if (!/^refs\/remotes\/[A-Za-z0-9_./-]+$/.test(expected.integrationRef || '')
        || git(expected.repo, ['merge-base', '--is-ancestor', expected.sha, expected.integrationRef]).code !== 0) refuse('LANDING_UNPROVEN');
  }
  const root = path.dirname(file);
  return withClaimsTransaction(path.join(root, 'claims.json'), () => {
    const before = paths.readFileGuarded(root, file);
    if (!before.ok) refuse('REGISTRY_REFUSED');
    const { parseRegistry } = require('../../.ai/bin/lib/candidate-registry.cjs');
    const parsed = parseRegistry(before.bytes); let changed = 0;
    for (const { index, cells } of parsed.rows) {
      if (cells[1] !== expected.branch || cells[2] !== expected.sha || !(target === 'retired' ? ['landed'] : ['certified']).includes(cells[4])) continue;
      cells[4] = target; cells[5] = new Date(expected.now).toISOString();
      parsed.lines[index] = '| ' + cells.join(' | ') + ' |'; changed++;
    }
    if (!changed) return 0;
    const bytes = Buffer.from(parsed.lines.join('\n')); parseRegistry(bytes);
    const current = paths.readFileGuarded(root, file);
    if (!current.ok || !current.bytes.equals(before.bytes)) refuse('REGISTRY_CHANGED');
    if (!paths.writeAtomicGuarded(file, bytes, { root }).ok) refuse('REGISTRY_WRITE_REFUSED');
    return changed;
  });
}
const retireRows = (file, expected) => transitionLandedRows(file, expected, 'retired');
const landRows = (file, expected) => transitionLandedRows(file, expected, 'landed');
module.exports = { readRegistry, validate, pinCheck, pinDecode, pinHtmlRefused, pinViews, pinSkeleton, currentOf, checkRegister, safeMachineId, parseOwner, retireRows, landRows, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
