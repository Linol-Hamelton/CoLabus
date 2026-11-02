'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getRepoRoot, git } = require('./procfs.cjs');

function isSafeRelativePath(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (/[*?"<>|]/.test(p)) return false;
  const norm = path.normalize(p);
  if (norm.startsWith('..') || norm === '..') return false;
  return true;
}

function validateRegistry(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('registry must be a JSON object');
  }
  for (const k of Object.keys(obj)) {
    if (k !== 'schema' && k !== 'clients') throw new Error(`unknown registry top-level key "${k}"`);
  }
  if (obj.schema !== 'clients/1') {
    throw new Error(`unsupported registry schema "${obj.schema}"`);
  }
  if (!obj.clients || typeof obj.clients !== 'object' || Array.isArray(obj.clients)) {
    throw new Error('registry.clients must be an object');
  }
  const requiredClientKeys = [
    'binary', 'present', 'version', 'verifiedOn', 'source',
    'command', 'model', 'effort', 'env', 'resume', 'usage', 'failureModes'
  ];
  for (const [cName, cCfg] of Object.entries(obj.clients)) {
    if (!cCfg || typeof cCfg !== 'object' || Array.isArray(cCfg)) {
      throw new Error(`client "${cName}" must be an object`);
    }
    for (const req of requiredClientKeys) {
      if (!(req in cCfg)) throw new Error(`client "${cName}" missing required key "${req}"`);
    }
    if (typeof cCfg.binary !== 'string') throw new Error(`client "${cName}".binary must be string`);
    if (typeof cCfg.present !== 'boolean') throw new Error(`client "${cName}".present must be boolean`);
    if (!Array.isArray(cCfg.command)) throw new Error(`client "${cName}".command must be array`);
  }
  return obj;
}

function loadRegistry(filePath) {
  const p = filePath || path.resolve(__dirname, '..', '..', 'docs', 'clients.json');
  let raw = '';
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new Error(`cannot read registry file "${p}": ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`registry file "${p}" is not valid JSON: ${e.message}`);
  }
  return validateRegistry(parsed);
}

// Slot key packet: false rolls back delivery; an object supplies the compile context (PROTO-DEC-0183.5).
// It is validated even while the wiring switch is off, so a typo is caught when the file is written, not when the switch is turned on.
function validatePacketSpec(s) {
  const p = s.packet;
  const id = s.id;
  if (p === false) return;
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`slot "${id}".packet must be an object`);
  for (const k of Object.keys(p)) {
    if (!['mode', 'stage', 'frame', 'triggers'].includes(k)) throw new Error(`unknown packet key "${k}" in slot "${id}"`);
  }
  if (p.mode !== undefined && p.mode !== 'inline' && p.mode !== 'pointer') throw new Error(`slot "${id}".packet.mode must be "inline" or "pointer"`);
  if (typeof p.stage !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.stage)) throw new Error(`slot "${id}".packet.stage must be a stage id`);
  if (typeof s.role !== 'string' || !s.role) throw new Error(`slot "${id}" needs a role because it has a packet key`);
  if (p.frame !== undefined && (typeof p.frame !== 'string' || !isSafeRelativePath(p.frame))) throw new Error(`slot "${id}".packet.frame must be a safe relative path`);
  if (p.triggers !== undefined && (!Array.isArray(p.triggers) || p.triggers.some(t => typeof t !== 'string' || !t))) throw new Error(`slot "${id}".packet.triggers must be an array of strings`);
}

function validateDispatch(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('dispatch must be a JSON object');
  }
  const allowedTopKeys = ['version', 'stateDir', 'usageFile', 'runsFile', 'startLimitMin', 'stallMin', 'hardMin', 'runLimitHours', 'packetPolicy', 'slots', 'jobs'];
  for (const k of Object.keys(obj)) {
    if (!allowedTopKeys.includes(k)) throw new Error(`unknown top-level key "${k}"`);
  }
  if (obj.runsFile !== undefined) {
    if (typeof obj.runsFile !== 'string' || !obj.runsFile) {
      throw new Error('runsFile must be a non-empty string');
    }
    if (!isSafeRelativePath(obj.runsFile)) {
      throw new Error(`runsFile must be a safe relative path; got "${obj.runsFile}"`);
    }
  }
  if (obj.stallMin !== undefined) {
    if (typeof obj.stallMin !== 'number' || !Number.isInteger(obj.stallMin) || obj.stallMin < 5 || obj.stallMin > 120) {
      throw new Error(`stallMin must be an integer between 5 and 120; got ${obj.stallMin}`);
    }
  }
  if (obj.hardMin !== undefined) {
    if (typeof obj.hardMin !== 'number' || !Number.isInteger(obj.hardMin) || obj.hardMin < 10 || obj.hardMin > 720) {
      throw new Error(`hardMin must be an integer between 10 and 720; got ${obj.hardMin}`);
    }
  }
  if (obj.packetPolicy !== undefined && obj.packetPolicy !== 'required' && obj.packetPolicy !== 'off') {
    throw new Error(`packetPolicy must be "required" or "off"; got ${JSON.stringify(obj.packetPolicy)}`);
  }
  const slotsRaw = obj.slots || obj.jobs;
  if (!Array.isArray(slotsRaw) || !slotsRaw.length) {
    throw new Error('dispatch must contain a non-empty slots array');
  }
  const allowedSlotKeys = [
    'id', 'frame', 'out', 'outputs', 'launch', 'copyIn', 'needs', 'when', 'adopted',
    'route', 'fallback', 'git', 'role', 'floor', 'constraints', 'independence',
    'substitutes', 'stageKind', 'long', 'approval', 'validate', 'budget', 'notBefore', 'packet'
  ];
  for (const s of slotsRaw) {
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('slot must be an object');
    for (const k of Object.keys(s)) {
      if (!allowedSlotKeys.includes(k)) throw new Error(`unknown slot key "${k}" in slot "${s.id}"`);
    }
    if (s.notBefore && typeof s.notBefore !== 'string') throw new Error(`slot "${s.id}".notBefore must be a string`);
    if (s.packet !== undefined) validatePacketSpec(s);
    if (obj.packetPolicy === 'required' && s.packet === undefined) {
      throw new Error(`slot "${s.id}" needs a packet key because packetPolicy is "required"`);
    }
    if (!s.id || typeof s.id !== 'string') throw new Error('slot.id must be a non-empty string');
    if (!s.launch || typeof s.launch !== 'string') throw new Error(`slot "${s.id}" missing launch path`);
    if (!isSafeRelativePath(s.launch)) throw new Error(`slot "${s.id}" unsafe launch path: "${s.launch}"`);
    if (s.out && !isSafeRelativePath(s.out)) throw new Error(`slot "${s.id}" unsafe out path: "${s.out}"`);
    if (s.outputs) {
      if (!Array.isArray(s.outputs)) throw new Error(`slot "${s.id}".outputs must be an array`);
      for (const p of s.outputs) {
        if (!isSafeRelativePath(p)) throw new Error(`slot "${s.id}" unsafe output path: "${p}"`);
      }
    }
    if (s.copyIn) {
      if (!Array.isArray(s.copyIn)) throw new Error(`slot "${s.id}".copyIn must be an array`);
      for (const p of s.copyIn) {
        if (!isSafeRelativePath(p)) throw new Error(`slot "${s.id}" unsafe copyIn path: "${p}"`);
      }
    }
    if (s.when) {
      if (typeof s.when !== 'object') throw new Error(`slot "${s.id}".when must be an object`);
      if (s.when.file && !isSafeRelativePath(s.when.file)) throw new Error(`slot "${s.id}" unsafe when.file path: "${s.when.file}"`);
    }
    if (s.git) {
      if (typeof s.git !== 'object') throw new Error(`slot "${s.id}".git must be an object`);
      if (s.git.mode === 'BRANCH_PUSH' || s.git.mode === 'RELEASE_PUSH') {
        throw new Error('no publisher exists');
      }
    }

    if (s.budget !== undefined) {
      throw new Error('budget not supported in v0');
    }
    if (s.constraints !== undefined) {
      if (typeof s.constraints !== 'object' || s.constraints === null || Array.isArray(s.constraints)) {
        throw new Error(`slot "${s.id}".constraints must be an object`);
      }
      for (const ck of Object.keys(s.constraints)) {
        if (ck !== 'contextMin') throw new Error(`constraint "${ck}" not supported in v0`);
      }
      if (s.constraints.contextMin !== undefined) {
        if (typeof s.constraints.contextMin !== 'number' || !Number.isInteger(s.constraints.contextMin) || s.constraints.contextMin <= 0) {
          throw new Error(`slot "${s.id}".constraints.contextMin must be a positive integer`);
        }
      }
    }
    if (s.substitutes !== undefined) {
      if (typeof s.substitutes !== 'number' || !Number.isInteger(s.substitutes) || s.substitutes < 0 || s.substitutes > 2) {
        throw new Error(`slot "${s.id}".substitutes must be an integer between 0 and 2; got ${s.substitutes}`);
      }
    }
    if (s.stageKind !== undefined && !['kernel', 'certification', 'other'].includes(s.stageKind)) {
      throw new Error(`slot "${s.id}".stageKind must be "kernel", "certification", or "other"`);
    }
    if (s.long !== undefined && typeof s.long !== 'boolean') {
      throw new Error(`slot "${s.id}".long must be a boolean`);
    }
    if (s.validate !== undefined && s.validate !== null && !Array.isArray(s.validate)) {
      throw new Error(`slot "${s.id}".validate must be an array or null`);
    }

    if (!s.route) {
      if (!s.role || typeof s.role !== 'string') {
        throw new Error(`slot "${s.id}" missing role (required when slot has no route)`);
      }
      if (!s.floor || typeof s.floor !== 'string' || !/^T[1-9]$/.test(s.floor)) {
        throw new Error(`slot "${s.id}" missing or invalid floor (must be T1..T9)`);
      }
    }
  }
  return obj;
}

function loadDispatch(filePath) {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`cannot read dispatch file "${filePath}": ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`dispatch file "${filePath}" is not valid JSON: ${e.message}`);
  }
  return validateDispatch(parsed);
}

function loadLadder(ladderPath, repoRoot = getRepoRoot()) {
  const fullPath = path.resolve(repoRoot, ladderPath);
  let raw = '';
  try {
    raw = fs.readFileSync(fullPath, 'utf8');
  } catch (e) {
    throw Object.assign(new Error(`cannot read ladder file "${fullPath}": ${e.message}`, { cause: e }), { code: e.code });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw Object.assign(new Error(`ladder file "${fullPath}" is not valid JSON: ${e.message}`, { cause: e }), { code: 'LADDER_JSON_MALFORMED' });
  }
  // the version of the exact file the resolver read (ladderVersion of a resolution); not enumerable, so the parsed data is unchanged
  if (parsed && typeof parsed === 'object') {
    Object.defineProperty(parsed, 'fileSha256', { value: crypto.createHash('sha256').update(raw).digest('hex'), enumerable: false });
  }
  return parsed;
}

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

// The part of the client registry a ladder/2 file is built from: per client its presence,
// version, verification date, model list and model/effort rules. A note or quota edit elsewhere in the registry does not make the
// ladder stale; a change of any of these fields does.
function clientsProjection(registry) {
  const out = {};
  for (const name of Object.keys((registry && registry.clients) || {}).sort()) {
    const c = registry.clients[name] || {};
    const effortItem = Array.isArray(c.command) ? c.command.find(i => i && typeof i === 'object' && i.if === 'effort') || null : null;
    out[name] = { present: c.present, version: c.version, verifiedOn: c.verifiedOn, models: c.models || null, model: c.model || null, effort: c.effort || null, effortArgs: effortItem ? effortItem.args : null };
  }
  return out;
}

// Digests of the sources a ladder/2 file names: the model matrix (whole file, its rows are cited by line), the client registry
// projection and the history file of the owner's working ladder. Returns { ok, reason?, digests }.
function ladderSourceDigests(sources, repoRoot = getRepoRoot()) {
  const digests = {};
  for (const key of ['matrix', 'clients', 'history']) {
    const src = sources && sources[key];
    if (!src || !src.path) return { ok: false, reason: `source-missing:${key}`, digests };
    const full = path.resolve(repoRoot, src.path);
    if (!fs.existsSync(full)) return { ok: false, reason: `source-not-found:${key}`, digests };
    const raw = fs.readFileSync(full);
    if (key === 'clients') {
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { return { ok: false, reason: 'source-invalid:clients', digests }; }
      digests.clients = sha256(JSON.stringify(clientsProjection(parsed)));
    } else {
      digests[key] = sha256(raw);
    }
  }
  return { ok: true, digests };
}

function verifyLadderSectionSha256(ladder, repoRoot = getRepoRoot()) {
  if (!ladder || !ladder.source || !ladder.source.path || !ladder.source.heading) {
    return { ok: false, reason: 'missing-source-metadata' };
  }
  if (ladder.schema === 'ladder/2') {
    const d = ladderSourceDigests(ladder.sources, repoRoot);
    if (!d.ok) return { ok: false, reason: d.reason };
    for (const key of ['matrix', 'clients', 'history']) {
      if (d.digests[key] !== ladder.sources[key].sha256) {
        return { ok: false, reason: `source-sha-mismatch:${key}`, expected: ladder.sources[key].sha256, actual: d.digests[key] };
      }
    }
  }
  const fullPath = path.resolve(repoRoot, ladder.source.path);
  if (!fs.existsSync(fullPath)) {
    return { ok: false, reason: 'source-not-found' };
  }
  const content = fs.readFileSync(fullPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = content.split('\n');
  const start = lines.indexOf(ladder.source.heading);
  if (start === -1) {
    return { ok: false, reason: 'heading-not-found' };
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  if (end === -1) end = lines.length;
  const sectionText = lines.slice(start, end).join('\n') + '\n';
  const hash = crypto.createHash('sha256').update(sectionText).digest('hex');
  if (hash !== ladder.source.sectionSha256) {
    return { ok: false, reason: 'section-sha-mismatch', expected: ladder.source.sectionSha256, actual: hash };
  }
  return { ok: true, sha256: hash };
}

module.exports = { validateRegistry, loadRegistry, validateDispatch, loadDispatch, loadLadder, verifyLadderSectionSha256, clientsProjection, ladderSourceDigests };
