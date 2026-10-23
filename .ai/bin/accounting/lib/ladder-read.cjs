'use strict';
// Read-only reader of the model identity sources of the repository (PROTO-DEC-0143 item 3: the layer reads, never writes them):
//   docs/ops/model-ladder.json               the owner's working ladder (rungs)
//   .ai/docs/clients.json                    the client registry (models reachable per client)
//   .ai/core/L3-tools/trial/MODEL-MATRIX.md  provider matrix: flagship / second / workhorse per maker (P-L3-003)
// This module is the only layer file that names these paths; the static guard requires that it
// carries no write API. Nothing read here is copied anywhere except into the layer's own derived data files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class LadderError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const GEMINI_EFFORT = /^(gemini-[\d.]+-(?:flash|pro))-(low|medium|high)$/;
const ID_CELL = /^[a-z0-9][a-z0-9._-]*$/;
const CLASS_WORDS = ['flagship', 'second', 'workhorse'];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Canonical model id: the effort suffix of a Gemini route id is split off (it is an effort, not a model).
 * @param {string} raw
 * @returns {{id: string, effort: string|null}}
 */
function canonicalId(raw) {
  const m = GEMINI_EFFORT.exec(raw);
  return m ? { id: m[1], effort: m[2] } : { id: raw, effort: null };
}

function readFile(file, code) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    throw new LadderError(code, `cannot read ${file}: ${e.code || e.message}`);
  }
}

/**
 * @param {string} repoRoot
 * @returns {{path: string, sha256: string, snapshot: string|null, rungs: object[], unresolved: object[]}}
 */
function readLadder(repoRoot) {
  const file = path.join(repoRoot, 'docs', 'ops', 'model-ladder.json');
  const buf = readFile(file, 'LADDER_UNREADABLE');
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new LadderError('LADDER_UNREADABLE', `${file} is not valid JSON`); }
  const rungs = [];
  const unresolved = [];
  for (const r of j.rungs || []) {
    if (r.model === null || r.model === undefined) {
      unresolved.push({ rung: r.rung, order: r.order, label: r.label, client: r.client });
      continue;
    }
    const c = canonicalId(r.model);
    rungs.push({ rung: r.rung, order: r.order, label: r.label, client: r.client, model: c.id, rawModel: r.model, effort: c.effort || r.effort || null, provider: r.provider });
  }
  return { path: 'docs/ops/model-ladder.json', sha256: sha(buf), snapshot: (j.source && j.source.snapshot) || null, rungs, unresolved, rungCount: (j.rungs || []).length };
}

/**
 * @param {string} repoRoot
 * @returns {{path: string, sha256: string, models: Map<string, {clients: string[]}>}}
 */
function readClients(repoRoot) {
  const file = path.join(repoRoot, '.ai', 'docs', 'clients.json');
  const buf = readFile(file, 'CLIENTS_UNREADABLE');
  let j;
  try { j = JSON.parse(buf.toString('utf8')); } catch { throw new LadderError('CLIENTS_UNREADABLE', `${file} is not valid JSON`); }
  const models = new Map();
  for (const [client, v] of Object.entries(j.clients || {})) {
    for (const raw of (v && Array.isArray(v.models)) ? v.models : []) {
      const { id } = canonicalId(raw);
      if (!models.has(id)) models.set(id, { clients: [] });
      if (!models.get(id).clients.includes(client)) models.get(id).clients.push(client);
    }
  }
  return { path: '.ai/docs/clients.json', sha256: sha(buf), models };
}

/**
 * Parse the per-maker sections of MODEL-MATRIX.md: the model ids of each table and the "Ranks:" paragraph.
 * @param {string} repoRoot
 * @returns {{path: string, sha256: string, ids: Map<string, string>, classes: {id: string, maker: string, classes: string[], line: number, text: string}[]}}
 */
function readMatrix(repoRoot) {
  const rel = '.ai/core/L3-tools/trial/MODEL-MATRIX.md';
  const buf = readFile(path.join(repoRoot, '.ai', 'core', 'L3-tools', 'trial', 'MODEL-MATRIX.md'), 'MATRIX_UNREADABLE');
  const lines = buf.toString('utf8').split('\n');
  const ids = new Map();
  const classes = [];
  let maker = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^###\s+(.+?)\s+[—-]\s+/.exec(line) || /^###\s+(\S+)\s*$/.exec(line);
    if (/^#{1,2}\s/.test(line)) maker = null;
    if (h && /^###\s/.test(line)) { maker = h[1].trim(); continue; }
    if (!maker) continue;
    if (/^\|/.test(line)) {
      const first = line.split('|')[1];
      if (!first) continue;
      for (const piece of first.replace(/`/g, '').split(',')) {
        const tok = piece.trim().split(/[\s(]/)[0];
        if (tok && ID_CELL.test(tok) && /[-\d]/.test(tok)) ids.set(canonicalId(tok).id, maker);
      }
      continue;
    }
    if (/^Ranks:/.test(line)) {
      let text = line;
      for (let j = i + 1; j < lines.length && lines[j].trim() !== ''; j++) text += ` ${lines[j].trim()}`;
      const all = /fills all three/.test(text);
      const per = new Map();
      for (const b of text.matchAll(/\*\*([^*]+)\*\*/g)) {
        const parts = b[1].trim().split(/\s+/);
        if (CLASS_WORDS.includes(parts[0]) && parts[1]) {
          const id = canonicalId(parts[1]).id;
          per.set(id, [...(per.get(id) || []), parts[0]]);
        } else if (all) {
          per.set(canonicalId(parts[0]).id, [...CLASS_WORDS]);
        }
      }
      for (const [id, cl] of per) {
        classes.push({ id, maker, classes: cl, line: i + 1, text: line.trim() });
        if (!ids.has(id)) ids.set(id, maker);
      }
    }
  }
  return { path: rel, sha256: sha(buf), ids, classes };
}

/**
 * Union of the three sources with their provenance.
 * @param {string} repoRoot
 * @returns {{models: object[], ladder: object, clients: object, matrix: object}}
 */
function buildUniverse(repoRoot) {
  const ladder = readLadder(repoRoot);
  const clients = readClients(repoRoot);
  const matrix = readMatrix(repoRoot);
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) by.set(id, { id, onLadder: false, rungs: [], clients: [], inClients: false, inMatrix: false, matrixMaker: null });
    return by.get(id);
  };
  for (const r of ladder.rungs) {
    const m = get(r.model);
    m.onLadder = true;
    m.rungs.push({ rung: r.rung, order: r.order, label: r.label, client: r.client, effort: r.effort });
  }
  for (const [id, v] of clients.models) {
    const m = get(id);
    m.inClients = true;
    m.clients = v.clients;
  }
  for (const [id, maker] of matrix.ids) {
    const m = get(id);
    m.inMatrix = true;
    m.matrixMaker = maker;
  }
  const models = [...by.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  return { models, ladder, clients, matrix };
}

module.exports = { LadderError, canonicalId, readLadder, readClients, readMatrix, buildUniverse };
