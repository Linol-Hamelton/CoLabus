'use strict';
// Cooperative Git-metadata authority, outside candidate trees. Not an OS sandbox.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const safe = require('../../lib/path-safe.cjs');
const { seatEnvironment } = require('../../lib/seat-heavy.cjs');
const { checkProcessAlive } = require('../../protocol-session.cjs');
const PATHS = Object.freeze(['.ai/TASK.md', '.ai/PLAN.md', '.ai/DECISIONS.md', '.ai/ARCHIVE.md', 'docs/decisions/REGISTRY.md']);
const NOTES = 'refs/notes/protocol-shared-doc-lock';
const KEY = 'protocol-shared-doc-key';
const CODE = 'TRAIN-LAND-SHARED-DOC';
// The lock record and the integration key are small. A session state also holds the file-hash
// snapshot of its checkout (about 100 bytes per file), so it is read whole up to a bound that fits
// a tree of a third of a million files; authority uses only its owner, pid, supervisorPid and nonce.
const RECORD_MAX_BYTES = 65536;
const STATE_MAX_BYTES = 32 * 1024 * 1024;
const refuse =detail => { throw Object.assign(new Error(`${CODE}: ${detail}`), { code: CODE, detail }); };

function shortAlias(segment, canonical) {
  const parts = value => {
    const dot = value.lastIndexOf('.');
    return dot > 0 ? [value.slice(0, dot), value.slice(dot + 1)] : [value.replace(/^\.+/, ''), ''];
  };
  const [stem, ext] = parts(segment), [longStem, longExt] = parts(canonical);
  const clean = value => value.replace(/[ .]/g, '');
  const base = clean(longStem);
  if (ext !== clean(longExt).slice(0, 3) || stem.length > 8) return false;
  const numbered = /^([a-z0-9]{1,6})~[1-9][0-9]{0,5}$/.exec(stem);
  // Short names depend on the volume and collision count. Refuse the possible
  // numeric and hashed NTFS families, without consulting the checkout filesystem.
  return Boolean(numbered && base.startsWith(numbered[1])) ||
    (stem.slice(0, 2) === base.slice(0, 2) && /^[a-z0-9]{2}[0-9a-f]{4}~[1-9]$/.test(stem));
}
function protectedPath(file) {
  const segments = file.replace(/\\/g, '/').split('/').map(p => p.toLowerCase().replace(/[ .]+$/g, ''));
  return PATHS.find(p => p.toLowerCase().split('/').every((part, i, all) =>
    segments.length === all.length && (segments[i] === part || shortAlias(segments[i], part))));
}
function changed(git, base, tip) {
  // No pathspec: deleted paths and both sides of renames must be inspected.
  const files = git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', base, tip, '--']).split('\0');
  for (const file of files) {
    const canonical = protectedPath(file);
    if (canonical && file !== canonical) refuse(`noncanonical-shared-document-path: ${JSON.stringify(file)} aliases ${canonical}`);
  }
  return PATHS.filter(p => files.includes(p));
}
function assertPackage(git, base, tip) {
  const files = changed(git, base, tip);
  if (files.length) refuse(`package edits shared document ${files.join(', ')}`);
}
function location(git) {
  const dir = path.resolve(git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim());
  return { dir, main: path.dirname(dir) };
}
function read(root, name, max = RECORD_MAX_BYTES) {
  // The bound is judged on the opened descriptor before any byte is read; links, hardlinks and
  // components that leave the root stay refused by the guarded read.
  const result = safe.readFileGuarded(root, path.join(root, name), { maxBytes: max });
  if (!result.ok || result.bytes.length > max) refuse('lock authority unavailable');
  return result.bytes;
}
const sessionState = (main, owner) => JSON.parse(read(main, `.ai/runtime/${owner}.json`, STATE_MAX_BYTES));
function lockAuthority(git, repo, owner, env) {
  if (seatEnvironment(env)) refuse('operator integration is unavailable to an author seat');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owner || '')) refuse('invalid lock owner');
  const { dir, main } = location(git);
  if (fs.realpathSync(repo) !== fs.realpathSync(main)) refuse('operator integration requires the main checkout');
  const lockBytes = read(main, '.ai/runtime/shared-writer.json');
  let lock, state;
  try {
    lock = JSON.parse(lockBytes);
    state = sessionState(main, owner);
  } catch { refuse('registered lock unavailable'); }
  const pid = lock.sessionPid || lock.pid;
  if (lock.owner !== owner || lock.hostname !== os.hostname() ||
      !Number.isInteger(pid) || pid <= 4 || !checkProcessAlive(pid) ||
      ![state.pid, state.supervisorPid].includes(pid) ||
      typeof state.nonce !== 'string' || !state.nonce ||
      crypto.createHash('sha256').update(state.nonce).digest('hex') !== lock.tokenHash ||
      !Number.isFinite(Date.parse(lock.acquiredAt)) || Date.parse(lock.acquiredAt) > Date.now()) refuse('registered live lock required');
  return {
    dir, owner, acquiredAt: lock.acquiredAt,
    lockDigest: crypto.createHash('sha256').update(lockBytes).digest('hex'),
    recheck() {
      if (!lockBytes.equals(read(main, '.ai/runtime/shared-writer.json'))) refuse('shared-document lock moved');
      const again = sessionState(main, owner);
      if (again.nonce !== state.nonce || ![again.pid, again.supervisorPid].includes(pid) || !checkProcessAlive(pid)) refuse('shared-document session moved');
    },
  };
}
function key(dir, create = false) {
  const file = path.join(dir, KEY);
  const checked = safe.realInside(dir, file, { refuseHardlinks: true });
  if (!checked.ok) refuse('unsafe integration authority');
  if (!checked.exists && create) {
    try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') refuse('integration authority creation failed'); }
  }
  const bytes = read(dir, KEY);
  if (bytes.length !== 32) refuse('invalid integration authority');
  return bytes;
}
// New or changed nonlegacy decisions must carry their canonical block hash before the
// integration receives authority. Read immutable Git objects, never checkout bytes.
function assertDecisionPins(git, parent, commit) {
  if (!changed(git, parent, commit).includes('.ai/DECISIONS.md')) return;
  const { decisionHashes } = require('../../validator/governance.cjs');
  const legacy = require('../../validator/decision-legacy.cjs');
  const previous = decisionHashes(git(['show', `${parent}:.ai/DECISIONS.md`]));
  const current = decisionHashes(git(['show', `${commit}:.ai/DECISIONS.md`]));
  const hasLegacyBaseline = current.has(legacy.baseline.toLowerCase());
  const updated = [...current].filter(([id, entry]) => previous.get(id)?.sha256 !== entry.sha256
    && !(hasLegacyBaseline && legacy.blocks[id] === entry.sha256));
  if (!updated.length) return;
  let registry = '';
  try { registry = git(['show', `${commit}:docs/decisions/REGISTRY.md`]); } catch { /* Missing registry has no pins. */ }
  const rows = registry.split(/\r?\n/).filter(line => /^\s*\|\s*(?:PROTO-)?DEC-\d{4}\s*\|/i.test(line))
    .map(line => line.trim().split('|').slice(1, -1).map(cell => cell.trim()));
  for (const [id, entry] of updated) {
    const matching = rows.filter(cells => cells[0].toLowerCase() === id);
    const metadata = matching.find(cells => cells.length === 6 || cells.length === 7)?.slice(0, 6)
      || [entry.id, '<date>', 'Accepted', '-', 'owner-directive', '<source>'];
    const expected = `| ${[...metadata, entry.sha256].join(' | ')} |`;
    const pins = matching.filter(cells => cells.length === 7);
    if (!pins.length) refuse(`decision ${entry.id} has no registry hash pin; expected row: ${expected}`);
    if (pins.some(cells => cells[6] !== entry.sha256)) refuse(`decision ${entry.id} has an incorrect registry hash pin; expected row: ${expected}`);
  }
}
function attest(git, authority, commit, parent, tree) {
  assertDecisionPins(git, parent, commit);
  authority.recheck();
  const body = { schema: 'shared-doc-lock/1', commit, parent, tree, owner: authority.owner,
    acquiredAt: authority.acquiredAt, lockDigest: authority.lockDigest };
  const mac = crypto.createHmac('sha256', key(authority.dir, true)).update(JSON.stringify(body)).digest('hex');
  // Input goes through stdin; neither key nor authentication bytes enter argv.
  git(['notes', `--ref=${NOTES}`, 'add', '-F', '-', commit], CODE, { input: `${JSON.stringify({ body, mac })}\n` });
}
function assertIntegration(git, commit, parent) {
  const files = changed(git, parent, commit);
  if (!files.length) return;
  try {
    const { dir } = location(git);
    const text = git(['notes', `--ref=${NOTES}`, 'show', commit]);
    if (text.length > 65536) throw Error('oversize');
    const { body, mac } = JSON.parse(text);
    const expected = crypto.createHmac('sha256', key(dir)).update(JSON.stringify(body)).digest();
    if (!/^[a-f0-9]{64}$/.test(mac) || !crypto.timingSafeEqual(Buffer.from(mac, 'hex'), expected) ||
        body.schema !== 'shared-doc-lock/1' || body.commit !== commit || body.parent !== parent ||
        body.tree !== git(['rev-parse', `${commit}^{tree}`]).trim()) throw Error('invalid');
  } catch { refuse(`integration lacks authenticated lock receipt for ${files.join(', ')}`); }
}
function authorWarnings(git, base) {
  try {
    const mb = git(['merge-base', '--all', base, 'HEAD']).trim().split('\n');
    if (mb.length !== 1 || !/^[a-f0-9]{40,64}$/.test(mb[0])) throw Error('base');
    return changed(git, mb[0], 'HEAD').map(p => `AUTHOR-CHECK WARN ${CODE}: package edits shared document ${p}`);
  } catch (error) {
    if (error.code === CODE) return [`AUTHOR-CHECK WARN ${error.message}`];
    return []; // Advisory only; author selection owns Git failures.
  }
}
module.exports = { PATHS, CODE, STATE_MAX_BYTES, changed, assertPackage, lockAuthority, assertDecisionPins, attest, assertIntegration, authorWarnings };
