'use strict';
// Pure R1 parsing; Git, filesystem and publication remain in adapters.
const { decode, maskMarkdown, parseJsonUnique } = require('./text-safe.cjs');
const CLOSED_P_NUMBER = /^P-(?:[0-9]{2}|[1-9][0-9]{2,3})$/;
const err = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code, detail });
function readRenumber(message) {
  const lines = message.trimEnd().split('\n');
  const found = lines.filter(line => /register-renumber\s*:/i.test(line));
  if (!found.length) return null;
  if (found.length !== 1 || !/^Register-Renumber: (\{.*\})$/.test(found[0]) ||
      !message.trimEnd().split('\n\n').at(-1).split('\n').includes(found[0])) {
    throw err('TRAIN-LAND-RENUMBER', 'invalid Register-Renumber trailer');
  }
  let value;
  try { value = parseJsonUnique(found[0].slice('Register-Renumber: '.length)); }
  catch { throw err('TRAIN-LAND-RENUMBER', 'invalid Register-Renumber JSON'); }
  if (JSON.stringify(value) !== found[0].slice('Register-Renumber: '.length)) {
    throw err('TRAIN-LAND-RENUMBER', 'noncanonical Register-Renumber JSON');
  }
  if (value.version === 2) {
    validateRenumberV2(value, found[0]);
    if (!/^Landed-Tip: [a-f0-9]{40}$/.test(lines[lines.indexOf(found[0]) + 1] || '')) {
      throw err('TRAIN-LAND-RENUMBER', 'V2 must immediately precede Landed-Tip');
    }
  }
  return value;
}

function validateRenumberV2(value, line = `Register-Renumber: ${JSON.stringify(value)}`) {
  const F = require('./register-fragments.cjs');
  const need = condition => { if (!condition) throw err('TRAIN-LAND-RENUMBER', 'invalid V2 Register-Renumber'); };
  const keys = (v, names) => need(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).join() === names.join());
  need(Buffer.byteLength(line, 'utf8') <= 8192);
  keys(value, ['version', 'launches', 'legacy']);
  need(value.version === 2 && Array.isArray(value.launches) && value.launches.length > 0);
  const ids = new Set(); let prior = 0;
  for (const r of value.launches) {
    keys(r, ['launchId', 'ordinal', 'entryDigest']);
    need(typeof r.launchId === 'string' && F.LAUNCH.test(r.launchId) && !ids.has(r.launchId) &&
      Number.isSafeInteger(r.ordinal) && r.ordinal > prior && typeof r.entryDigest === 'string' && F.DIGEST.test(r.entryDigest));
    ids.add(r.launchId); prior = r.ordinal;
  }
  keys(value.legacy, ['packages', 'notRewritten']);
  need(Array.isArray(value.legacy.packages) && Array.isArray(value.legacy.notRewritten));
  let commit = '';
  for (const p of value.legacy.packages) {
    keys(p, ['commit', 'ids']);
    need(typeof p.commit === 'string' && F.SHA.test(p.commit) && p.commit > commit); commit = p.commit;
    need(p.ids && typeof p.ids === 'object' && !Array.isArray(p.ids) && Object.keys(p.ids).length > 0);
    const pairs = Object.entries(p.ids), seen = new Set();
    const order = id => (id.startsWith('P-') ? 0 : 10000) + Number(id.slice(id.indexOf('-') + 1));
    need(pairs.every(([from, to], i) => typeof to === 'string' && from !== to &&
      (F.P.test(from) && F.P.test(to) || F.OR.test(from) && F.OR.test(to)) &&
      !seen.has(to) && seen.add(to) && (!i || order(pairs[i - 1][0]) < order(from))));
  }
  for (const r of value.legacy.notRewritten) {
    keys(r, ['file', 'package', 'ids']);
    need(typeof r.file === 'string' && typeof r.package === 'string' && F.SHA.test(r.package) &&
      r.ids && typeof r.ids === 'object' && !Array.isArray(r.ids) && Object.keys(r.ids).length > 0 &&
      Object.entries(r.ids).every(([from, to]) => typeof to === 'string' && from !== to &&
        (F.P.test(from) && F.P.test(to) || F.OR.test(from) && F.OR.test(to))));
  }
  return value;
}

function buildRenumberV2(additions, legacy = null) {
  const F = require('./register-fragments.cjs');
  const launches = additions.map(bytes => {
    const r = require('./register-landing.cjs').json(bytes);
    return { launchId: r.launchId, ordinal: r.landingOrdinal, entryDigest: F.digest(bytes) };
  });
  return validateRenumberV2({ version: 2, launches, legacy: legacy
    ? { packages: legacy.packages, notRewritten: legacy.notRewritten } : { packages: [], notRewritten: [] } });
}

function parseRegisterRows(source) {
  const d = decode(Buffer.isBuffer(source) ? source : Buffer.from(source, 'utf8'), { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!d.ok) throw err('TRAIN-LAND-CONFLICT', 'PROCESS-REGISTER.md failed strict text decode');
  const lines = d.text.split('\n');
  const structure = lines.map(line => (/^ {0,3}\|/.test(line) ? `${line.match(/^ */)[0]}| cell |` : line)).join('\n');
  const rows = [];
  const ids = new Set();
  const bodies = new Set();
  for (const ctx of maskMarkdown(structure).lines) {
    const rawLine = lines[ctx.line - 1];
    if (!/^ {0,3}\|/.test(rawLine)) continue;
    if (ctx.kinds.some(k => !['table', 'code-span', 'inline-link', 'html-inline-tag'].includes(k))) {
      throw err('TRAIN-LAND-CONFLICT', `ambiguous register row at line ${ctx.line}`);
    }
    const m = /^ {0,3}\|[ \t]*([^|]*?)[ \t]*\|(.*)$/.exec(rawLine);
    if (!m) throw err('TRAIN-LAND-CONFLICT', `malformed register row at line ${ctx.line}`);
    const id = m[1].trim();
    const cells = rawLine.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
    const labels = cells.map(c => c.toLowerCase()).join('|');
    if (['id|process', 'id|process|since|trigger|command|documented in|owner|enforced by|status'].includes(labels)) continue;
    if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue;
    if (!/\|[ \t]*$/.test(rawLine) || ![2, 9].includes(cells.length) || !CLOSED_P_NUMBER.test(id)) {
      throw err('TRAIN-LAND-CONFLICT', `invalid register row ${id} at line ${ctx.line}`);
    }
    const cellKinds = maskMarkdown(rawLine).lines[0].kinds;
    if (!cellKinds.every(k => ['table', 'code-span', 'inline-link', 'html-inline-tag'].includes(k)) || /<\/?summary(?:\s|\/?>)/i.test(rawLine)) {
      throw err('TRAIN-LAND-CONFLICT', `unsupported markdown in register row ${id}`);
    }
    if (ids.has(id)) throw err('TRAIN-LAND-PROCESS-DUPLICATE', `duplicate register id (${id})`);
    if (bodies.has(m[2])) throw err('TRAIN-LAND-CONFLICT', `duplicate register body (${id})`);
    ids.add(id);
    bodies.add(m[2]);
    rows.push({ id, body: m[2], line: rawLine });
  }
  const dataSet = new Set(rows.map(r => r.line));
  const skeleton = lines.filter(l => !dataSet.has(l)).join('\n');
  return { text: d.text, lines, rows, skeleton };
}

module.exports = { readRenumber, parseRegisterRows, validateRenumberV2, buildRenumberV2 };
