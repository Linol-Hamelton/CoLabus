'use strict';
// Release composition from git (R-L2-013.27, backlog 3.13). Read-only.
// The number and the list of packages a release carries come only from the
// landed squash commits ("land <branch> as one commit", Landed-Tip trailer)
// between the previous release tag and the line head, never from memory.
//   release-composition.cjs [--root DIR] [--from TAG] [--to REF] [--json]
//   release-composition.cjs check --report FILE [--root DIR] [--from TAG] [--to REF]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readLanding } = require('../operator/landed-proof.cjs');
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA = /^[0-9a-f]{40}$/;
function defaultGit(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.error ? null : r.status, stdout: String(r.stdout || '') };
}
function previousReleaseTag(git, to) {
  const r = git(['tag', '--merged', to, '--sort=-version:refname', '--list', 'v*']);
  if (r.status !== 0) throw Error('GIT_REFUSED');
  return r.stdout.split('\n').map(s => s.trim()).find(t => RELEASE_TAG.test(t)) || null;
}
function compose(options = {}, deps = {}) {
  const root = path.resolve(options.root || '.');
  const git = deps.git ? args => deps.git(root, args) : args => defaultGit(root, args);
  const to = options.to || 'HEAD';
  if (!REF.test(to)) throw Error('INPUT_REFUSED');
  const head = git(['rev-parse', '--verify', '--quiet', `${to}^{commit}`]);
  if (head.status !== 0 || !SHA.test(head.stdout.trim())) throw Error('HEAD_UNRESOLVED');
  const from = options.from || previousReleaseTag(git, to);
  if (!from) throw Error('NO_RELEASE_TAG');
  if (!REF.test(from)) throw Error('INPUT_REFUSED');
  const base = git(['rev-parse', '--verify', '--quiet', `refs/tags/${from}^{commit}`]);
  if (base.status !== 0 || !SHA.test(base.stdout.trim())) throw Error('TAG_UNRESOLVED');
  // The same filter as the landing proof: subject lines that start with "land ".
  const log = git(['log', '--no-show-signature', '--no-notes', '--grep=^land ', '--format=%H%x00%B%x00', `${base.stdout.trim()}..${head.stdout.trim()}`]);
  if (log.status !== 0) throw Error('GIT_REFUSED');
  const fields = log.stdout.split('\0');
  const landings = [], unparsed = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const commit = fields[i].trim(), message = fields[i + 1];
    if (!SHA.test(commit)) throw Error('GIT_REFUSED');
    if (!message.startsWith('land ')) continue;
    const parsed = readLanding(message);
    if (parsed.reason) unparsed.push({ commit, reason: parsed.reason });
    else landings.push({ commit, branch: parsed.branch, tip: parsed.tip || null, prefix: parsed.prefix });
  }
  const key = l => l.tip || l.prefix;
  const seen = new Map();
  for (const l of landings) seen.set(key(l), (seen.get(key(l)) || 0) + 1);
  const duplicateTips = [...seen].filter(([, n]) => n > 1).map(([tip]) => tip).sort();
  const packages = [...new Set(landings.map(l => l.branch))].sort();
  return { from, fromCommit: base.stdout.trim(), to, head: head.stdout.trim(), landings: landings.length + unparsed.length, packages: packages.length, packageList: packages, landed: landings, unparsed, duplicateTips };
}
// The one number line a report must carry when it names the composition.
function countLine(c) { return `RELEASE-COMPOSITION from=${c.from} landings=${c.landings} packages=${c.packages}`; }
function checkReport(text, c) {
  const found = [...String(text).matchAll(/^RELEASE-COMPOSITION from=(\S+) landings=(\d+) packages=(\d+)$/gm)];
  if (found.length === 0) return { ok: false, reason: 'COUNT_LINE_MISSING' };
  if (found.length > 1) return { ok: false, reason: 'COUNT_LINE_MULTIPLE' };
  return found[0][0] === countLine(c) ? { ok: true } : { ok: false, reason: 'COUNT_LINE_MISMATCH', expected: countLine(c) };
}
function readFlags(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--json') { options.json = true; continue; }
    const key = allowed[flag];
    if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('USAGE');
    options[key] = argv[++i];
  }
  return options;
}
function main(argv, deps = {}, out = s => process.stdout.write(s)) {
  const flags = { '--root': 'root', '--from': 'from', '--to': 'to', '--report': 'report' };
  try {
    const check = argv[0] === 'check';
    const options = readFlags(check ? argv.slice(1) : argv, flags);
    if (check !== Object.hasOwn(options, 'report')) throw Error('USAGE');
    const c = compose(options, deps);
    if (check) {
      const verdict = checkReport(fs.readFileSync(path.resolve(options.report), 'utf8'), c);
      out(`${JSON.stringify({ ...verdict, line: countLine(c) })}\n`);
      return verdict.ok ? 0 : 1;
    }
    if (options.json) out(`${JSON.stringify(c)}\n`);
    else {
      out(`${countLine(c)}\nHEAD ${c.head}\n`);
      for (const b of c.packageList) out(`${b}\n`);
      if (c.unparsed.length) out(`UNPARSED ${c.unparsed.map(u => `${u.commit.slice(0, 8)}:${u.reason}`).join(' ')}\n`);
      if (c.duplicateTips.length) out(`DUPLICATE-TIPS ${c.duplicateTips.join(' ')}\n`);
    }
    return 0;
  } catch (e) {
    out(`${JSON.stringify({ ok: false, reason: /^[A-Z_]+$/.test(e.message) ? e.message : 'INPUT_REFUSED' })}\n`);
    return 2;
  }
}
module.exports = { previousReleaseTag, compose, countLine, checkReport, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
