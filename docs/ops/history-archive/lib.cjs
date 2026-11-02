'use strict';
// lib.cjs - shared parts of the history archive builder (hashing, secret scan, content-addressed store, manifest, read-only git).
// Node builtins only. Class B tooling, NON-DESTRUCTIVE: nothing in this file removes, moves or rewrites a source file.
// The only mutating calls are in the Store and manifest helpers and every one of them first checks that the target lies inside
// the archive root (assertInside).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const cp = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');

const posix = (p) => String(p).replace(/\\/g, '/');
const norm = (p) => posix(path.resolve(String(p))).replace(/\/+$/, '').toLowerCase();

// ---------------------------------------------------------------- paths and guards
// true when child is strictly inside parent (both resolved; case-insensitive on the drive like the rest of the project)
function isInside(child, parent) {
  const c = norm(child);
  const p = norm(parent);
  return c !== p && c.startsWith(`${p}/`);
}
function assertInside(child, parent, what = 'path') {
  if (!isInside(child, parent) && norm(child) !== norm(parent)) throw new Error(`refused: ${what} ${posix(child)} is not inside ${posix(parent)}`);
}

// ---------------------------------------------------------------- hashing
const sha256Buf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function sha256File(abs) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const b = Buffer.allocUnsafe(1 << 20);
    for (;;) { const n = fs.readSync(fd, b, 0, b.length, null); if (!n) break; h.update(b.subarray(0, n)); }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// ---------------------------------------------------------------- secret shapes
// SHARED list: an exact copy of SECRETS in .ai/bin/accounting/launch-record-validate.cjs (not exported there;
// Regression tests compare the two source texts, so drift fails a test). LOCAL list: LOCAL_SECRETS of docs/ops/channels-lib.cjs (exported there, required below).
const SHARED_SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/,
];
let LOCAL_SECRETS = [];
try { LOCAL_SECRETS = require('../channels-lib.cjs').LOCAL_SECRETS || []; } catch { LOCAL_SECRETS = []; }
// cheap substring gates: a pattern runs on a chunk only when its anchor occurs in it (the local assignment pattern has no cheap anchor)
const GATES = new Map();
SHARED_SECRETS.forEach((re, i) => GATES.set(re, [['sk-'], ['ghp_'], ['github_pat_'], ['AIza'], ['xox'], ['AKIA'], ['earer', 'EARER'], ['PRIVATE KEY'], ['API_KEY', 'TOKEN', 'SECRET', 'PASSWORD']][i]));
const ALL_PATTERNS = () => [...SHARED_SECRETS, ...LOCAL_SECRETS];
const SCAN_CHUNK = 32 * 1024 * 1024;
const globalOf = (re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
const GLOBALS = new Map();
const globalFor = (re) => { if (!GLOBALS.has(re)) GLOBALS.set(re, globalOf(re)); return GLOBALS.get(re); };

// scan one text chunk; baseLine = 1-based line number of the chunk's first line. Adds to acc ({ count, lines:Set }). Never returns match text.
function scanChunk(text, baseLine, acc) {
  let starts = null;
  const lineAt = (idx) => {
    if (!starts) { starts = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1); }
    let lo = 0; let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= idx) lo = mid; else hi = mid - 1; }
    return baseLine + lo;
  };
  for (const re of ALL_PATTERNS()) {
    const gate = GATES.get(re);
    if (gate && !gate.some((g) => text.includes(g))) continue;
    const g = globalFor(re);
    g.lastIndex = 0;
    let m;
    let guard = 0;
    while ((m = g.exec(text)) !== null) {
      acc.count += 1;
      if (acc.lines.size < 200) acc.lines.add(lineAt(m.index));
      if (m[0].length === 0) g.lastIndex += 1;
      if (++guard > 100000) break;
    }
  }
}
function newAcc() { return { count: 0, lines: new Set() }; }
const finishAcc = (acc) => ({ count: acc.count, lines: [...acc.lines].sort((a, b) => a - b).slice(0, 50) });

// scan a Buffer (a text file read whole). Binary files (NUL in the first 8 KB) are scanned as latin1 text: a key inside a database is still a key.
function scanBuffer(buf) {
  const acc = newAcc();
  const text = buf.toString(looksBinary(buf) ? 'latin1' : 'utf8');
  scanChunk(text, 1, acc);
  return finishAcc(acc);
}
function looksBinary(buf) { const n = Math.min(buf.length, 8192); for (let i = 0; i < n; i++) if (buf[i] === 0) return true; return false; }

// ---------------------------------------------------------------- one pass over a file: sha256, size, secret scan (chunked, cut at newline bytes)
const SMALL_FILE = 64 * 1024 * 1024;
// opts.scan: false skips the secret scan (secretShaped stays null); opts.scanMax: files above this many bytes are not scanned (null)
function analyzeFile(abs, opts = {}) {
  const st = fs.statSync(abs);
  const scan = opts.scan !== false && (opts.scanMax == null || st.size <= opts.scanMax);
  if (st.size <= (opts.smallMax != null ? opts.smallMax : SMALL_FILE)) {
    const buf = fs.readFileSync(abs);
    return { sha256: sha256Buf(buf), size: buf.length, mtimeMs: st.mtimeMs, buf, binary: looksBinary(buf), secret: scan ? scanBuffer(buf) : null };
  }
  const h = crypto.createHash('sha256');
  const acc = newAcc();
  const fd = fs.openSync(abs, 'r');
  let size = 0; let line = 1; let tail = Buffer.alloc(0); let binary = false; let first = true;
  try {
    const chunk = Buffer.allocUnsafe(opts.chunk || SCAN_CHUNK);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!n) break;
      const piece = chunk.subarray(0, n);
      h.update(piece);
      size += n;
      if (first) { binary = looksBinary(piece); first = false; }
      if (!scan) continue;
      const data = tail.length ? Buffer.concat([tail, piece]) : piece;
      const cut = data.lastIndexOf(10);
      if (cut < 0) { tail = Buffer.from(data); continue; }
      const text = data.subarray(0, cut + 1).toString(binary ? 'latin1' : 'utf8');
      scanChunk(text, line, acc);
      line += (text.match(/\n/g) || []).length;
      tail = Buffer.from(data.subarray(cut + 1));
    }
    if (scan && tail.length) scanChunk(tail.toString(binary ? 'latin1' : 'utf8'), line, acc);
  } finally { fs.closeSync(fd); }
  return { sha256: h.digest('hex'), size, mtimeMs: st.mtimeMs, buf: null, binary, secret: scan ? finishAcc(acc) : null };
}

// ---------------------------------------------------------------- history layout
const histDir = (root) => path.join(root, 'history');
const layout = (root) => ({
  root,
  hist: histDir(root),
  objects: path.join(histDir(root), 'objects'),
  flagged: path.join(histDir(root), 'flagged', 'objects'),
  manifest: path.join(histDir(root), 'MANIFEST.jsonl'),
  runs: path.join(histDir(root), 'RUNS.jsonl'),
  records: path.join(histDir(root), 'RECORDS.jsonl'),
  trees: path.join(histDir(root), 'trees'),
  reports: path.join(histDir(root), 'reports'),
  bundles: path.join(root, 'bundles'),
  sessions: path.join(root, 'sessions'),
});

const GZ_MIN = 4096; // text (and any other) object larger than 4 KB is stored gzipped
const NO_GZ_EXT = /\.(gz|zip|7z|bundle|png|jpe?g|gif|webp|pdf|mp4|dll|exe)$/i;
const SHA_RE = /^[0-9a-f]{64}$/;

// A content-addressed store directory: <dir>/<aa>/<sha256 of the ORIGINAL bytes>[.gz]. The suffix says whether the stored bytes are gzipped.
class Store {
  constructor(dir, archiveRoot) { this.dir = dir; this.archiveRoot = archiveRoot; this.tmpN = 0; }
  paths(sha) { const d = path.join(this.dir, sha.slice(0, 2)); return { raw: path.join(d, sha), gz: path.join(d, `${sha}.gz`), dir: d }; }
  find(sha) {
    if (!SHA_RE.test(sha)) return null;
    const p = this.paths(sha);
    if (fs.existsSync(p.gz)) return { path: p.gz, gz: true };
    if (fs.existsSync(p.raw)) return { path: p.raw, gz: false };
    return null;
  }
  has(sha) { return this.find(sha) !== null; }
  read(sha) {
    const f = this.find(sha);
    if (!f) return null;
    const b = fs.readFileSync(f.path);
    return f.gz ? zlib.gunzipSync(b) : b;
  }
  // write an analysed file. `src` = { abs, sha256, size, buf? }. Returns { stored: bool (false: object already existed), gz, storedBytes }.
  async put(src, name) {
    const existing = this.find(src.sha256);
    if (existing) return { stored: false, gz: existing.gz, storedBytes: fs.statSync(existing.path).size };
    const gz = src.size > GZ_MIN && !NO_GZ_EXT.test(name || src.abs || '');
    const p = this.paths(src.sha256);
    assertInside(p.dir, this.archiveRoot, 'object directory');
    fs.mkdirSync(p.dir, { recursive: true });
    const tmpDir = path.join(this.dir, '.tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmp = path.join(tmpDir, `${process.pid}-${Date.now()}-${this.tmpN++}`);
    assertInside(tmp, this.archiveRoot, 'temporary object');
    const final = gz ? p.gz : p.raw;
    try {
      if (src.buf) {
        fs.writeFileSync(tmp, gz ? zlib.gzipSync(src.buf, { level: 6 }) : src.buf, { flag: 'wx' });
      } else {
        const h = crypto.createHash('sha256');
        let n = 0;
        const tee = new Transform({ transform(chunk, _e, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); } });
        const steps = [fs.createReadStream(src.abs), tee];
        if (gz) steps.push(zlib.createGzip({ level: 6 }));
        steps.push(fs.createWriteStream(tmp, { flags: 'wx' }));
        await pipeline(...steps);
        if (h.digest('hex') !== src.sha256 || n !== src.size) { removeOwnTemp(tmp); return { stored: false, changed: true, gz, storedBytes: 0 }; }
      }
      fs.renameSync(tmp, final);
    } catch (e) { removeOwnTemp(tmp); throw e; }
    return { stored: true, gz, storedBytes: fs.statSync(final).size };
  }
  // every object file: yields { sha, path, gz }
  *objects() {
    let subs = [];
    try { subs = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return; }
    for (const s of subs) {
      if (!s.isDirectory() || !/^[0-9a-f]{2}$/.test(s.name)) continue;
      for (const f of fs.readdirSync(path.join(this.dir, s.name))) {
        const m = /^([0-9a-f]{64})(\.gz)?$/.exec(f);
        if (m) yield { sha: m[1], path: path.join(this.dir, s.name, f), gz: Boolean(m[2]), prefix: s.name };
        else yield { sha: null, path: path.join(this.dir, s.name, f), gz: false, prefix: s.name };
      }
    }
  }
}
// the one place a partial object of this tool is removed: a `.tmp` file the tool itself created inside a store
function removeOwnTemp(p) { try { if (/[\\/]\.tmp[\\/]/.test(p)) fs.unlinkSync(p); } catch { /* already gone */ } }

// ---------------------------------------------------------------- manifest (JSONL, append only)
function readJsonl(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const ln of text.split('\n')) { if (!ln.trim()) continue; try { out.push(JSON.parse(ln)); } catch { out.push({ _corrupt: ln.slice(0, 40) }); } }
  return out;
}
function appendJsonl(file, rows, archiveRoot) {
  if (!rows.length) return;
  assertInside(file, archiveRoot, 'manifest');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}
function writeFileInside(file, text, archiveRoot) {
  assertInside(file, archiveRoot, 'output file');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

// Sessions archive (external manifest, read only): sha256 -> dest of the copy that already exists there.
function loadSessionsIndex(sessionsRoot) {
  const m = new Map();
  for (const r of readJsonl(path.join(sessionsRoot, 'MANIFEST.jsonl'))) if (r && r.sha256 && !m.has(r.sha256)) m.set(r.sha256, r.dest || r.source || 'sessions');
  return m;
}

// ---------------------------------------------------------------- read-only git
// Only these git sub-commands run against a LIVE repository. Every write goes to a scratch repository in OS temp.
const READ_ONLY = new Set(['rev-parse', 'rev-list', 'log', 'for-each-ref', 'merge-base', 'diff-tree', 'diff', 'ls-tree', 'cat-file', 'ls-files',
  'show', 'worktree', 'cherry', 'show-ref', 'count-objects', 'remote', 'config', 'bundle', 'status']);
function assertReadOnlyGit(args) {
  const c = args[0];
  if (!READ_ONLY.has(c)) throw new Error(`refused non read-only git command: ${c}`);
  if (c === 'worktree' && args[1] !== 'list') throw new Error(`refused: git worktree ${args[1]}`);
  if (c === 'bundle' && !['list-heads', 'verify'].includes(args[1])) throw new Error(`refused: git bundle ${args[1]}`);
  if (c === 'config' && !args.includes('--get') && !args.includes('--get-all') && !args.includes('--list')) throw new Error('refused: git config write');
  if (c === 'remote' && args[1] && args[1] !== '-v') throw new Error('refused: git remote write');
  if (c === 'status') throw new Error('refused: git status can refresh the index'); // use ls-files and diff-tree instead
}
function gitRead(cwd, args, o = {}) {
  assertReadOnlyGit(args);
  const r = cp.spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', ...args], {
    cwd, input: o.input, encoding: o.buffer ? 'buffer' : 'utf8', windowsHide: true, maxBuffer: 1 << 30,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
  });
  return { code: r.status, out: o.buffer ? r.stdout : String(r.stdout || '').replace(/\r?\n$/, ''), err: String(r.stderr || '') };
}

// worktrees registered in a repository: [{ path, head, branch, detached, locked, prunable, bare }]
function listWorktrees(repo) {
  const r = gitRead(repo, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) throw new Error(`git worktree list failed in ${posix(repo)}: ${r.err.slice(0, 120)}`);
  const res = [];
  let cur = null;
  for (const ln of r.out.split(/\r?\n/)) {
    if (ln.startsWith('worktree ')) { cur = { path: posix(ln.slice(9).trim()), head: null, branch: null, detached: false, locked: false, prunable: false, bare: false }; res.push(cur); }
    else if (!cur) continue;
    else if (ln.startsWith('HEAD ')) cur.head = ln.slice(5).trim();
    else if (ln.startsWith('branch ')) cur.branch = ln.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (ln === 'detached') cur.detached = true;
    else if (ln.startsWith('locked')) cur.locked = true;
    else if (ln.startsWith('prunable')) cur.prunable = true;
    else if (ln === 'bare') cur.bare = true;
  }
  return res.filter((w) => !w.bare);
}

const fmtMB = (b) => (b / 1048576).toFixed(2);
const isoDate = (d = new Date()) => d.toISOString().slice(0, 10);

module.exports = {
  posix, norm, isInside, assertInside, sha256Buf, sha256File, SHARED_SECRETS, LOCAL_SECRETS, scanBuffer, scanChunk, looksBinary, analyzeFile,
  layout, Store, GZ_MIN, NO_GZ_EXT, SHA_RE, readJsonl, appendJsonl, writeFileInside, loadSessionsIndex, gitRead, assertReadOnlyGit, listWorktrees, fmtMB, isoDate,
  SMALL_FILE, removeOwnTemp,
};
