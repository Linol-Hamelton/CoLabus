'use strict';
const fs = require('node:fs');
const path = require('node:path');
const io = require('./io.cjs');
const risk = require('../../docs/ops/risk-class.cjs');
const { maskMarkdown } = require('../../.ai/bin/lib/text-safe.cjs');
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const dimensionRegistry = require('./dimension-registry.cjs').load();

const SCHEMA = 'task-classifier/1';
// The task-scope IDs of the dimension registry; only its profile IDs carry a weight in a task profile.
const DIMENSIONS = dimensionRegistry.taskIds;
const PROFILE_IDS = dimensionRegistry.profileIds;
const DIMENSION_SOURCES = Object.freeze(['task-classifier/1', 'operator-override']);
const KINDS = Object.freeze(['mechanical', 'document', 'test', 'feature', 'fix-round', 'design', 'review', 'certify']);
const COMPLEXITY_FACTORS = Object.freeze(['protectedPaths', 'novelty', 'reversibility', 'ambiguity', 'coupling', 'independentJudgement']);

const DEFECT_RE = () => /(?:^|[^a-z0-9\p{L}\p{Nd}\p{M}_])defect class(?:es)?\s*:?\s*([0-9]{1,2}(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd})(?:\s*[,;]\s*[0-9]{1,2}(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd}))*)/giu;

function roundTokensOf(text) {
  const out = [];
  const re = /(?:^|[^a-z0-9\p{L}\p{Nd}\p{M}_])(?:round|rnd|r)[ \t-]*([0-9]{1,2})(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd})/giu;
  let m;
  while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
  return out;
}

function roundOfBody(content) {
  const seen = new Set();
  for (const line of maskMarkdown(content).lines) {
    if (line.masked || line.partial) continue;
    for (const r of roundTokensOf(line.text)) seen.add(r);
  }
  return { round: seen.size === 1 ? [...seen][0] : null, conflict: seen.size > 1 };
}

function roundIdentity(name, content) {
  const stem = name.replace(/\.md$/i, '');
  const fileTokens = roundTokensOf(stem);
  const fileSeen = new Set(fileTokens);
  const fn = fileSeen.size === 1 ? [...fileSeen][0] : null;
  const fileConflict = fn === null && fileTokens.length > 1;
  const body = roundOfBody(content);
  if (body.conflict || fileConflict) return `file:${name}`;
  if (fn !== null && body.round !== null && fn !== body.round) return `file:${name}`;
  const r = fn !== null ? fn : body.round;
  return r === null ? `file:${name}` : `round:${r}`;
}

function packageReportRe(packageId) {
  const esc = packageId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(?:\\d{4}-\\d{2}-\\d{2}-)?${esc}(?:[-.][^/]*)?$`);
}

function scanPackageReviews(repo, packageId, readUtf8) {
  const verdicts = [];
  const defectClasses = new Set();
  const failedRoundIds = new Set();
  let unknowns = 0;
  const reviewsDir = path.join(repo, 'docs', 'reviews');
  if (fs.existsSync(reviewsDir)) {
    const names = fs.readdirSync(reviewsDir).filter(n => n.endsWith('.md') && packageReportRe(packageId).test(n)).sort();
    for (const name of names) {
      let content;
      try { content = readUtf8(repo, `docs/reviews/${name}`); } catch { unknowns++; continue; }
      const v = readVerdict(content);
      if (v.token && ['closing', 'both'].includes(v.source)) {
        verdicts.push(v.token);
        if (v.token === 'FAIL') failedRoundIds.add(roundIdentity(name, content));
      } else unknowns++;
      for (const line of maskMarkdown(content).lines) {
        if (line.masked || line.partial) continue;
        const re = DEFECT_RE();
        let m;
        while ((m = re.exec(line.text)) !== null) {
          for (const part of m[1].split(/\s*[,;]\s*/)) {
            const n = Number(part);
            if (n >= 1 && n <= 14) defectClasses.add(n);
          }
        }
      }
    }
  }
  return {
    verdicts: verdicts.slice().sort(),
    failedRounds: failedRoundIds.size,
    defectClasses: [...defectClasses].sort((a, b) => a - b),
    unknowns,
  };
}

function isCodePath(p) { return /\.(?:[cm]?js|ts|ps1|sh|py|cmd|bat)$/i.test(p); }

function deriveRubric({ spec, protectedPaths, kind, role, coupling, unknowns = 0, verdicts = [], hasNewFiles = false }) {
  if (coupling === null || !Number.isInteger(protectedPaths)) return null;
  // A bounded local document/test edit has no runtime side effect. This is a
  // scope-derived estimate, not an operator declaration for automatic dispatch.
  if (!spec) return ['document', 'test'].includes(kind) ? {
    protectedPaths, novelty: hasNewFiles ? 1 : 0, reversibility: 0,
    ambiguity: 1, coupling: coupling > 2 ? 2 : coupling,
    independentJudgement: ['certifier', 'operator'].includes(role) ? 2 : role === 'pre-reviewer' ? 1 : 0,
  } : null;
  const novelty = spec.precedent === undefined
    ? (!hasNewFiles && ['fix-round', 'document', 'mechanical'].includes(kind) ? 0 : null)
    : { exists: 0, partial: 1, none: 2 }[spec.precedent];
  const reversibility = spec.externalEffect === true ? 2 : spec.requiresMigration === true ? 1
    : spec.externalEffect === false && spec.requiresMigration === false ? 0 : null;
  const independentJudgement = ['certifier', 'operator'].includes(role) || kind === 'design' || spec.specPrecision === 'open' ? 2
    : role === 'pre-reviewer' || spec.specPrecision === 'review' ? 1 : spec.specPrecision === 'exact' ? 0 : null;
  if ([novelty, reversibility, independentJudgement].includes(null)) return null;
  return { protectedPaths, novelty, reversibility,
    ambiguity: spec.openQuestions >= 3 || verdicts.includes('PASS') && verdicts.includes('FAIL') ? 2 : spec.openQuestions > 0 || unknowns > 0 ? 1 : 0,
    coupling: Math.min(2, coupling), independentJudgement };
}

function validateDimensionPair(dimension, dimensionSource) {
  if (dimension === undefined && dimensionSource === undefined) return;
  if (typeof dimension !== 'string') io.fail('dimension-invalid');
  try { io.operatorText(dimension); } catch { io.fail('dimension-invalid'); }
  if (!DIMENSIONS.includes(dimension)) io.fail('dimension-invalid');
  if (typeof dimensionSource !== 'string') io.fail('dimension-source-invalid');
  try { io.operatorText(dimensionSource); } catch { io.fail('dimension-source-invalid'); }
  if (!DIMENSION_SOURCES.includes(dimensionSource)) io.fail('dimension-source-invalid');
}

function validateDimensions(value) {
  const bad = () => io.fail('dimensions-invalid');
  if (!Array.isArray(value) || !value.length || value.length > 4) bad();
  const seen = new Set(); let sum = 0;
  for (const row of value) {
    if (!io.object(row) || Object.keys(row).sort().join(',') !== 'id,weight' || !PROFILE_IDS.includes(row.id) || seen.has(row.id)
        || !Number.isFinite(row.weight) || row.weight <= 0 || row.weight > 1 || Math.abs(row.weight * 100 - Math.round(row.weight * 100)) > 1e-9) bad();
    seen.add(row.id); sum += Math.round(row.weight * 100);
  }
  if (sum !== 100) bad();
  return value;
}
function checkedPath(p) {
  if (typeof p !== 'string' || p.length > 240 || p.includes('\\') || !risk.normalisePath(p).ok || risk.normalisePath(p).path !== p) io.fail('paths-invalid');
  io.operatorText(p);
  return p;
}
const MODES = ['000000', '100644', '100755', '120000', '160000'];
function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length > 10000) io.fail('diff-invalid');
  const seen = new Set();
  for (const c of changes) {
    io.fields(c, ['status', 'oldMode', 'newMode', 'paths'], ['status', 'oldMode', 'newMode', 'paths']);
    if (!/^(?:[AMDT]|[RC](?:100|0?[0-9]{1,2}))$/.test(c.status) || !MODES.includes(c.oldMode) || !MODES.includes(c.newMode)
        || !Array.isArray(c.paths) || c.paths.length !== (/^[RC]/.test(c.status) ? 2 : 1)
        || c.status === 'A' && c.oldMode !== '000000' || c.status === 'D' && c.newMode !== '000000') io.fail('diff-invalid');
    for (const p of c.paths) checkedPath(p);
    const key = io.canonical(c);
    if (seen.has(key)) io.fail('diff-invalid'); seen.add(key);
  }
}
function validateSpec(spec) {
  io.fields(spec, ['schema', 'kind', 'openQuestions', 'requiresMigration', 'externalEffect', 'precedent', 'specPrecision', 'dimensions', 'writeSet'], ['schema', 'openQuestions']);
  if (spec.schema !== 'task-spec/1' || !Number.isInteger(spec.openQuestions) || spec.openQuestions < 0 || spec.openQuestions > 100) io.fail('task-spec-invalid');
  if (spec.kind !== undefined && !['author', 'pre-review', ...KINDS].includes(spec.kind)) io.fail('task-spec-invalid');
  for (const key of ['requiresMigration', 'externalEffect']) if (spec[key] !== undefined && typeof spec[key] !== 'boolean') io.fail('task-spec-invalid');
  if (spec.precedent !== undefined && !['exists', 'partial', 'none'].includes(spec.precedent)
      || spec.specPrecision !== undefined && !['exact', 'review', 'open'].includes(spec.specPrecision)) io.fail('task-spec-invalid');
  if (spec.dimensions !== undefined) validateDimensions(spec.dimensions);
  if (spec.writeSet !== undefined) {
    if (!Array.isArray(spec.writeSet) || !spec.writeSet.length) io.fail('task-spec-invalid'); validateChanges(spec.writeSet);
    const paths = spec.writeSet.flatMap(c => c.paths).map(p => p.toLowerCase());
    if (new Set(paths).size !== paths.length) io.fail('task-spec-conflict');
  }
  io.publicValue(spec);
  return spec;
}
// Tests form a known layer; only unmapped paths leave coupling unknown.
function layerOf(p) {
  if (p.startsWith('tests/')) return 'tests';
  for (const prefix of ['.ai/bin/', '.ai/core/', '.claude/', '.codex/', '.github/', '.kilo/', 'docs/ops/', 'docs/specs/', 'docs/research/', 'docs/decisions/', 'docs/reviews/', 'templates/']) if (p.startsWith(prefix)) return prefix.slice(0, -1);
  if (p.startsWith('tools/')) { const parts = p.split('/'); return parts.length > 2 ? `tools/${parts[1]}` : 'tools'; }
  if (p.startsWith('docs/')) return 'docs';
  if (!p.includes('/')) return 'root';
  if (p.startsWith('.ai/')) return '.ai';
  return null;
}
function profileOf({ role, kind, paths, rows, lines, files }) {
  if (['certifier', 'pre-reviewer'].includes(role)) return [{ id: 'D-REV', weight: 1 }];
  const security = rows.some(r => /^RC-A(?:01|05|06)-/.test(r.rule)) || paths.some(p => /(?:^|\/)(?:secrets|path-safe|injection-scan)\./.test(p));
  const terminal = paths.some(p => /^tools\/(?:operator|ops-tools)\//.test(p) || /(?:^|\/)launch-/.test(p));
  const scores = new Map(); const add = (id, n) => scores.set(id, (scores.get(id) || 0) + n);
  // Protected/CLI paths take precedence over a document label. Combining rules
  // adds integer units first, deduplicates D-ARCH, then normalises once.
  if (security || terminal) { add('D-IMPL', 2); if (security) add('D-SEC', 2); if (terminal) add('D-TERM', 2); }
  else if (kind === 'document') add('D-DOC', 4);
  else if (kind === 'design') add('D-ARCH', 4);
  else if (kind === 'mechanical') { add('D-EDIT', 2); add('D-IMPL', 2); }
  else add('D-IMPL', 4);
  if (files >= 8 || lines !== null && lines > 1500) add('D-ARCH', [...scores.values()].reduce((a, b) => a + b, 0));
  const total = [...scores.values()].reduce((a, b) => a + b, 0);
  let remaining = 100;
  return [...scores].map(([id, n], i) => { const units = i === scores.size - 1 ? remaining : Math.round(n / total * 100); remaining -= units; return { id, weight: units / 100 }; });
}
function classifyTask(input) {
  const { role, packageId, manifestCtx = { manifest: new Set() }, history, spec } = input;
  if (!['author', 'fixer', 'pre-reviewer', 'certifier', 'operator'].includes(role)) io.fail('role-invalid');
  if (!io.id(packageId)) io.fail('package-id-invalid');
  io.fields(history, ['failedRounds', 'verdicts', 'defectClasses', 'unknowns'], ['failedRounds', 'verdicts', 'defectClasses', 'unknowns']);
  if (!io.count(history.failedRounds) || !io.count(history.unknowns) || !Array.isArray(history.verdicts)
      || !history.verdicts.every(v => ['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION'].includes(v)) || !Array.isArray(history.defectClasses)
      || !history.defectClasses.every(n => Number.isInteger(n) && n >= 1 && n <= 14) || !(input.lines === null || io.count(input.lines))) io.fail('classifier-invalid');
  if (spec !== undefined) validateSpec(spec);
  let changes = input.changes;
  validateChanges(changes);
  const writeSet = !changes.length;
  if (writeSet) { if (!spec?.writeSet) io.fail('no-changes'); changes = spec.writeSet; }
  const paths = [...new Set(changes.flatMap(c => c.paths))].sort();
  const rows = paths.map(p => risk.classifyPath(p, manifestCtx));
  const riskClass = rows.some(r => r.cls === 'A') ? 'A' : 'B';
  const layers = paths.map(layerOf);
  const coupling = layers.includes(null) ? null : new Set(layers).size - 1;
  const forcedKind = { certifier: 'certify', 'pre-reviewer': 'pre-review', fixer: 'fix-round' }[role];
  if (forcedKind && spec?.kind !== undefined && spec.kind !== forcedKind) io.fail('task-spec-conflict');
  const docsOnly = rows.every(r => ['RC-B04-document', 'RC-B05-docs-data'].includes(r.rule)) && !paths.some(isCodePath);
  const kind = forcedKind || spec?.kind || (history.failedRounds > 0 ? 'fix-round' : docsOnly ? 'document' : paths.every(p => p.startsWith('tests/')) ? 'test'
    : riskClass === 'B' && coupling === 0 && paths.length <= 2 && changes.every(c => c.status === 'M' && c.oldMode === '100644' && c.newMode === '100644') && input.lines !== null ? 'mechanical' : 'author');
  const heavy = rows.some(r => /^RC-A(?:01|04|06)-/.test(r.rule)) || paths.includes('docs/ops/selection-policy.json') || input.mutation === true;
  const verification = heavy ? 'heavy' : docsOnly ? 'light' : 'targeted';
  const protectedPaths = rows.some(r => /^RC-A(?:00|99)-/.test(r.rule)) ? null
    : rows.some(r => /^RC-A(?:01|02|03|04|05|06|10)-/.test(r.rule)) ? 2 : rows.some(r => r.cls === 'A') ? 1 : 0;
  const lines = writeSet ? null : input.lines;
  const complexity = deriveRubric({ spec, protectedPaths, kind, role, coupling, ...history, hasNewFiles: changes.some(c => c.status === 'A') });
  const dimensions = spec?.dimensions || profileOf({ role, kind, paths, rows, lines, files: paths.length });
  validateDimensions(dimensions);
  return { packageId, kind, paths, files: paths.length, lines, riskClass, ...history, verification, coupling, superImportant: false, complexity, dimensions,
    classifier: { schema: 'task-classification/1', evidence: { source: writeSet ? 'write-set' : 'git-diff', paths: paths.length, layers: [...new Set(layers.filter(Boolean))].sort(), unknownLayers: layers.includes(null), spec: spec !== undefined },
      proposed: { kind, verification, coupling, complexity, dimensions } }, classifierDisagreements: [] };
}
function validateAnnotations(task) {
  if (task.dimensions !== undefined) validateDimensions(task.dimensions);
  if (task.classifier !== undefined) {
    const c = task.classifier;
    io.fields(c, ['schema', 'evidence', 'proposed'], ['schema', 'evidence', 'proposed']);
    if (c.schema !== 'task-classification/1') io.fail('classifier-invalid');
    io.fields(c.evidence, ['source', 'paths', 'layers', 'unknownLayers', 'spec'], ['source', 'paths', 'layers', 'unknownLayers', 'spec']);
    if (!['git-diff', 'write-set'].includes(c.evidence.source) || !io.count(c.evidence.paths) || !Array.isArray(c.evidence.layers)
        || c.evidence.layers.some(l => typeof l !== 'string' || layerOf(`${l}/x`) !== l && l !== 'root')
        || new Set(c.evidence.layers).size !== c.evidence.layers.length || typeof c.evidence.unknownLayers !== 'boolean' || typeof c.evidence.spec !== 'boolean') io.fail('classifier-invalid');
    io.fields(c.proposed, ['kind', 'verification', 'coupling', 'complexity', 'dimensions'], ['kind', 'verification', 'coupling', 'complexity', 'dimensions']);
    for (const [field, value] of Object.entries(c.proposed)) validateProposal(field, value);
  }
  if (task.classifierDisagreements !== undefined) {
    if (!Array.isArray(task.classifierDisagreements) || task.classifierDisagreements.length > 5) io.fail('classifier-invalid');
    const seen = new Set();
    for (const d of task.classifierDisagreements) {
      io.fields(d, ['field', 'proposed', 'operator'], ['field', 'proposed', 'operator']);
      if (seen.has(d.field)) io.fail('classifier-invalid'); seen.add(d.field);
      validateProposal(d.field, d.proposed); validateProposal(d.field, d.operator);
      if (io.canonical(d.proposed) === io.canonical(d.operator)) io.fail('classifier-invalid');
    }
  }
  io.publicValue(task);
}
function validateProposal(field, value) {
  if (field === 'dimensions') return validateDimensions(value);
  if (field === 'kind' && ['author', 'pre-review', ...KINDS].includes(value)) return;
  if (field === 'verification' && ['light', 'targeted', 'heavy'].includes(value)) return;
  if (field === 'coupling' && (value === null || io.count(value))) return;
  if (field === 'complexity') {
    if (value === null) return;
    io.fields(value, COMPLEXITY_FACTORS, COMPLEXITY_FACTORS);
    if (COMPLEXITY_FACTORS.every(k => Number.isInteger(value[k]) && value[k] >= 0 && value[k] <= 2)) return;
  }
  io.fail('classifier-invalid');
}
function parseDiff(raw, numstat) {
  if (typeof raw !== 'string' || typeof numstat !== 'string' || raw && !raw.endsWith('\0') || numstat && !numstat.endsWith('\0')) io.fail('diff-invalid');
  const parts = raw.split('\0'); parts.pop(); const changes = [];
  while (parts.length) {
    const m = /^:([0-7]{6}) ([0-7]{6}) [a-f0-9]{40,64} [a-f0-9]{40,64} ([A-Z][0-9]*)$/.exec(parts.shift());
    if (!m) io.fail('diff-invalid');
    const count = /^[RC]/.test(m[3]) ? 2 : 1;
    changes.push({ status: m[3], oldMode: m[1], newMode: m[2], paths: parts.splice(0, count) });
  }
  validateChanges(changes);
  const stats = numstat.split('\0'); stats.pop(); let lines = 0; let binary = false; const statPaths = [];
  while (stats.length) {
    const m = /^(\d+|-)\t(\d+|-)\t([^\0]*)$/.exec(stats.shift());
    if (!m || (m[1] === '-') !== (m[2] === '-')) io.fail('diff-invalid');
    if (m[3]) statPaths.push(checkedPath(m[3]));
    else { if (stats.length < 2) io.fail('diff-invalid'); statPaths.push(checkedPath(stats.shift()), checkedPath(stats.shift())); }
    if (m[1] === '-') binary = true;
    else { lines += Number(m[1]) + Number(m[2]); if (!Number.isSafeInteger(lines)) io.fail('diff-invalid'); }
  }
  if (io.canonical(statPaths.slice().sort()) !== io.canonical(changes.flatMap(c => c.paths).sort())) io.fail('diff-invalid');
  return { changes, lines: binary ? null : lines };
}

function defaultGit(args, cwd) {
  return require('../operator/state.cjs').git(args, cwd);
}

function defaultReadUtf8(repo, rel) {
  return io.readText(repo, rel, 4 * 1024 * 1024, 'report');
}

function classifyFromRepo(opts = {}) {
  const repo = path.resolve(opts.repo || '.');
  const git = opts.git || defaultGit;
  const base = opts.base || 'v2.0.0';
  const head = opts.head || 'HEAD';
  const mergeBase = git(['merge-base', base, head], repo);
  const args = ['-z', '-M', '-C', '--find-copies-harder', '--no-abbrev', mergeBase, head];
  const diff = parseDiff(git(['diff', '--raw', ...args], repo), git(['diff', '--numstat', ...args], repo));
  const manifestOwned = require('./selection-policy.cjs').loadPolicy().obj.manifestOwned;
  const manifestCtx = { manifest: new Set(manifestOwned.map(p => p.toLowerCase())) };
  const history = opts.history || scanPackageReviews(repo, opts.packageId, opts.readUtf8 || defaultReadUtf8);
  return classifyTask({ ...diff, packageId: opts.packageId, role: opts.role, spec: opts.spec, history, manifestCtx });
}

module.exports = {
  validateSpec, validateDimensions, validateAnnotations, classifyTask, parseDiff, layerOf,
  SCHEMA,
  DIMENSIONS,
  DIMENSION_SOURCES,
  KINDS,
  COMPLEXITY_FACTORS,
  roundTokensOf,
  roundOfBody,
  roundIdentity,
  packageReportRe,
  scanPackageReviews,
  deriveRubric,
  validateDimensionPair,
  classifyFromRepo,
};
