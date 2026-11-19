'use strict';
// Commit identity facts: the author and committer that the NEXT commit in a repository will carry (git var
// GIT_AUTHOR_IDENT and GIT_COMMITTER_IDENT: the environment, the worktree, repository and global configuration,
// exactly as git resolves them). Only the landing commit is checked, never the history of a branch.
//   I-PLACEHOLDER (gate)  an empty name or email, an email whose domain ends in .invalid, .example or .localhost or
//                         is example.com, example.net or example.org, a domain with no dot (the bare word invalid or
//                         localhost: a real mail domain has a name and a top level), a domain with an empty name part (a leading,
//                         trailing or doubled dot) or an IP literal (dotted digits or a bracketed address), or a known test name (Cert Probe, and the
//                         ruleGates.identity.placeholderNames of protocol-manifest.json)
//   I-ALLOWED (warning)   an identity outside the allowed list: the machine's global git identity, plus
//                         ruleGates.identity.allowed (the declared owner and agent identities)
const { spawnSync } = require('node:child_process');

const PLACEHOLDER_NAMES = ['Cert Probe', 'Your Name', 'Test User'];
const PLACEHOLDER_DOMAIN = /(?:\.invalid|\.example|\.localhost|^example\.(?:com|net|org)|\.example\.(?:com|net|org))$/i;
// an IP literal as a mail domain: dotted digits, or a bracketed address (the bracket form has no real top level either)
const IP_HOST = /^(?:\[[^\]]*\]|\d{1,3}(?:\.\d{1,3}){3})$/;
const IDENT = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/;
const norm = s => String(s || '').trim().toLowerCase();
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function parseIdent(text) {
  const m = IDENT.exec(String(text || '').trim());
  return m ? { name: m[1].trim(), email: m[2].trim() } : null;
}
function placeholderReason(id, extraNames = []) {
  if (!id || !id.name) return 'empty name';
  if (!id.email) return 'empty email';
  const at = id.email.lastIndexOf('@');
  const domain = at >= 0 ? id.email.slice(at + 1) : '';
  if (!domain) return `email ${id.email} has no domain`;
  const host = domain.replace(/\.+$/, '');
  const labels = host.split('.');
  if (labels.length < 2) return `email domain ${domain} has no dot, so it is no real mail domain`;
  if (labels.some(l => l === '')) return `email domain ${domain} has an empty name part, so it is no real mail domain`;
  if (IP_HOST.test(host)) return `email domain ${domain} is an IP address, so it is no real mail domain`;
  if (PLACEHOLDER_DOMAIN.test(host)) return `email domain ${domain} is a placeholder domain`;
  const names = [...PLACEHOLDER_NAMES, ...extraNames.filter(n => typeof n === 'string')].map(norm);
  if (names.includes(norm(id.name))) return `name "${id.name}" is a known test name`;
  return null;
}
// cfg: ruleGates of the repository; global: { name, email } of the machine or null.
function allowedList(cfg, global) {
  const list = [];
  if (global && global.name && global.email) list.push(global);
  const extra = plain(cfg.identity) && Array.isArray(cfg.identity.allowed) ? cfg.identity.allowed : [];
  for (const a of extra) if (plain(a) && typeof a.name === 'string' && typeof a.email === 'string') list.push({ name: a.name, email: a.email });
  return list;
}
const allowed = (id, list) => list.some(a => norm(a.email) === norm(id.email) && norm(a.name) === norm(id.name));

function globalIdentity(run = spawnSync) {
  const q = key => { const r = run('git', ['config', '--global', '--get', key], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); return r.status === 0 ? (r.stdout || '').trim() : ''; };
  const name = q('user.name'); const email = q('user.email');
  return name && email ? { name, email } : null;
}
// -> facts for rule-gates runGate. repo: the directory the commit is made in; cfg: ruleGates; env: the commit's environment.
function identityFacts(repo, cfg = {}, { run = spawnSync, env = process.env, global } = {}) {
  const facts = [];
  const g = global === undefined ? globalIdentity(run) : global;
  const list = allowedList(cfg, g);
  const extraNames = plain(cfg.identity) && Array.isArray(cfg.identity.placeholderNames) ? cfg.identity.placeholderNames : [];
  for (const role of ['AUTHOR', 'COMMITTER']) {
    const r = run('git', ['-C', repo, 'var', `GIT_${role}_IDENT`], { encoding: 'utf8', windowsHide: true, timeout: 15000, env });
    const id = r.status === 0 ? parseIdent(r.stdout) : null;
    const who = role.toLowerCase();
    if (!id) { facts.push({ code: 'I-PLACEHOLDER', ok: false, level: 'gate', detail: `git cannot tell the ${who} identity of the next commit (${((r.stderr || '').trim().split('\n')[0] || `exit ${r.status}`).slice(0, 160)})`, fix: 'set the owner identity with git config --global user.name and user.email' }); continue; }
    const bad = placeholderReason(id, extraNames);
    if (bad) { facts.push({ code: 'I-PLACEHOLDER', ok: false, level: 'gate', detail: `${who} "${id.name} <${id.email}>": ${bad}`, fix: `remove the placeholder from the repository configuration (git config --unset user.name and user.email in ${repo}) or from the environment, so the commit carries the owner identity` }); continue; }
    facts.push({ code: 'I-PLACEHOLDER', ok: true, level: 'gate' });
    facts.push(allowed(id, list) ? { code: 'I-ALLOWED', ok: true, level: 'warn' } : { code: 'I-ALLOWED', ok: false, level: 'warn', detail: `${who} "${id.name} <${id.email}>" is not in the allowed list (${list.length} identit${list.length === 1 ? 'y' : 'ies'})`, fix: 'add it to ruleGates.identity.allowed of protocol-manifest.json when it is a real identity of the project' });
  }
  return facts;
}

module.exports = { PLACEHOLDER_NAMES, parseIdent, placeholderReason, allowedList, globalIdentity, identityFacts };
