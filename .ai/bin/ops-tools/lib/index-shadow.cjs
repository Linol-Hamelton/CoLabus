'use strict';
// The landing tree owns the append-only observation stream. No clock, branch
// name, session state or environment variable participates in its bytes.
const fs = require('node:fs');
const path = require('node:path');
const { loadIndex, serializeIndex, readStoredIndex } = require('../../protocol-consumers.cjs');
const LEDGER = 'docs/ops/INDEX-SHADOW.jsonl';
const fail = why => { throw Error(`INDEX-SHADOW-ERROR: ${why}`); };
const validSha = value => typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/.test(value);
function observations(text) {
  if (text && !text.endsWith('\n')) fail('ledger needs a final newline');
  if (text.includes('\r')) fail('ledger rows end with LF only');
  const rows = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line)) : [];
  let divergence = 0, clean = 0;
  const seen = new Set();
  for (const row of rows) {
    if (!row || Object.keys(row).sort().join() !== 'divergence,equal,sha,train' ||
        !validSha(row.train) || !validSha(row.sha) || typeof row.equal !== 'boolean' ||
        seen.has(row.train) || row.divergence !== divergence + Number(!row.equal)) fail('invalid observation');
    seen.add(row.train); divergence = row.divergence; clean = row.equal ? clean + 1 : 0;
  }
  return { rows, divergence, clean };
}
function policy(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'));
  const mode = manifest.consumerIndex?.mode || 'off';
  if (!['off', 'shadow'].includes(mode)) fail('unsupported mode (removal is a separate 2.0.3 change)');
  return mode;
}
function record(root, train, sha) {
  if (policy(root) === 'off') return { active: false };
  const file = path.join(root, LEDGER);
  const text = fs.readFileSync(file, 'utf8');
  const prior = observations(text);
  if (!validSha(train) || !validSha(sha) || prior.rows.some(r => r.train === train)) fail('invalid landing identity');
  const equal = serializeIndex(loadIndex(root, { cache: false })) === readStoredIndex(root);
  const row = { train, sha, equal, divergence: prior.divergence + Number(!equal) };
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  return { active: true, ...row, clean: equal ? prior.clean + 1 : 0,
    warning: equal ? null : 'INDEX-SHADOW-DIVERGENCE' };
}
module.exports = { LEDGER, observations, policy, record };
