'use strict';
// One declared scope-file reader for the source PRE gate and actual POST checker.
// Protected lists keep their separate purposes; parsing never grants permissions.
const path = require('node:path');
const textSafe = require('./text-safe.cjs');
const pathSafe = require('./path-safe.cjs');
const fold = s => s.normalize('NFC').toUpperCase();

function parsePattern(raw) {
  if (typeof raw !== 'string' || !raw) throw new Error('scope pattern is missing');
  let text = raw.replace(/\\/g, '/').normalize('NFC');
  let tree = false;
  if (text.endsWith('/**')) { tree = true; text = text.slice(0, -3); }
  else if (text.endsWith('/')) { tree = true; text = text.slice(0, -1); }
  const segments = text.split('/');
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (!/^[\p{L}\p{N}._@+=*-]+$/u.test(s) || s.includes('**') ||
        (s.includes('*') && (i !== segments.length - 1 || tree)) ||
        s.length > 255 || /~[0-9]/.test(s) || pathSafe.segmentProblem(s.replace(/\*/g, 'x'))) throw new Error('unsupported scope pattern');
  }
  return { raw, segments, tree, glob: segments.at(-1).includes('*') };
}

function pathMatches(candidate, target) {
  const e = parsePattern(target.trim());
  const parts = candidate.replace(/\\/g, '/').normalize('NFC').split('/');
  if (parts.length < e.segments.length || (e.glob && parts.length !== e.segments.length)) return false;
  return e.segments.every((seg, i) => {
    if (!seg.includes('*')) return fold(seg) === fold(parts[i]);
    const escaped = fold(seg).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${escaped}$`, 'u').test(fold(parts[i]));
  });
}

function parsePaths(text, options = {}) {
  const decoded = textSafe.decode(Buffer.from(text, 'utf8'), { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) throw new Error('scope text refused');
  // Backticks wrapping one declaration are syntax; other Markdown stays masked.
  const plain = decoded.text.replace(/^((?:[-*] )?)`([^`\n]+)`$/gm, '$1$2');
  const raws = textSafe.maskMarkdown(plain).lines.filter(l => !l.masked && !l.partial)
    .map(l => l.text.trim()).filter(l => l && !l.startsWith('#'))
    .map(l => l.replace(/^[-*]\s+/, ''));
  for (const raw of raws) parsePattern(raw.startsWith('!') ? raw.slice(1) : raw);
  if (!raws.length && !options.allowEmpty) throw new Error('scope contains no own declarations');
  if (raws.length && raws.every(r => r.startsWith('!'))) throw new Error('scope contains only exclusions');
  return raws;
}

// Every input is read below the repository root, never the volume root: a scope or
// forbidden file elsewhere on the drive is refused, not read.
function readText(root, file, missingLabel) {
  const abs = path.resolve(root, file);
  const guarded = pathSafe.readFileGuarded(root, abs);
  if (!guarded.ok) {
    const g = missingLabel && pathSafe.realInside(root, abs, { refuseHardlinks: true });
    if (g && g.ok && !g.exists) {
      const relative = path.relative(root, abs).replace(/\\/g, '/');
      throw new Error(`${missingLabel} file not found: ${relative}`);
    }
    throw new Error('scope input path refused');
  }
  const decoded = textSafe.decode(guarded.bytes, { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) throw new Error('scope input encoding refused');
  return decoded.text;
}

// The ONE reader of the Forbidden paths / Phase 0 forbidden declaration of a TASK text.
// Closed grammar of an own line: optional indentation, one list marker (bullet or number),
// an optional checkbox, an optional bold opener, the label, any words up to the colon, an
// optional bold closer, then a comma separated list. Lines masked as foreign Markdown
// (fence, quote, comment, code span, HTML block) are not the document's statement; every
// other line that names the label must parse or the call refuses. Never defaults.
const DECLARATION = /(?:forbidden paths?|phase 0 forbidden)[^\n:]*:/i;
const OWN_LINE = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?(?:\*\*|__)?[ \t]*(?:forbidden paths?|phase 0 forbidden)[^\n:]*:(?:\*\*|__)?[ \t]*(.*?)[ \t]*(?:\*\*|__)?[ \t]*$/i;
function taskForbiddenDeclaration(text) {
  const found = [];
  for (const line of textSafe.maskMarkdown(text).lines) {
    if (line.masked && !(line.kinds.length === 1 && line.kinds[0] === 'indented-code')) continue;
    if (!DECLARATION.test(line.text)) continue;
    if (line.partial) throw new Error('TASK forbidden declaration is partly masked');
    const m = OWN_LINE.exec(line.text);
    if (!m) throw new Error('TASK forbidden declaration must start its own line');
    if (!m[1]) throw new Error('TASK forbidden declaration names no path');
    // '#' is outside the closed path grammar. Never silently shorten a
    // protection declaration or treat its comment as another path.
    if (m[1].includes('#')) throw new Error('TASK forbidden inline comments are unsupported; use a separate # comment line');
    const paths = m[1].split(',').map(x => x.trim());
    if (paths.some(x => !x)) throw new Error('TASK forbidden declaration has an empty path');
    found.push(paths);
  }
  const signatures = new Set(found.map(a => JSON.stringify(a.map(fold).sort())));
  if (signatures.size > 1) throw new Error('TASK forbidden declarations disagree');
  return found[0] || null;
}

function snapshotInputs(cwd, scopeFile, forbiddenFile, snapshot, defaults) {
  cwd = path.resolve(cwd);
  const scopeText = snapshot === undefined ? readText(cwd, scopeFile, 'Scope') : snapshot.scopeText;
  const scope = parsePaths(scopeText);
  let forbiddenText;
  if (snapshot !== undefined) forbiddenText = snapshot.forbiddenText;
  else if (forbiddenFile) forbiddenText = readText(cwd, forbiddenFile, 'Forbidden paths');
  else {
    const task = path.join(cwd, '.ai/TASK.md');
    const g = pathSafe.realInside(cwd, task, { refuseHardlinks: true });
    if (!g.ok) throw new Error('TASK scope source path refused');
    const declared = g.exists ? taskForbiddenDeclaration(readText(cwd, task)) : null;
    forbiddenText = (declared || defaults).join('\n') + '\n';
  }
  const forbidden = parsePaths(forbiddenText, { allowEmpty: snapshot !== undefined });
  if (forbidden.some(x => x.startsWith('!'))) throw new Error('forbidden exclusions are unsupported');
  return { scopeText: scope.join('\n'), forbiddenText: forbidden.join('\n') };
}

function verifyTouchedPaths(root, paths) {
  root = path.resolve(root);
  for (const p of paths) {
    const guard = pathSafe.realInside(root, path.resolve(root, p), { refuseHardlinks: true });
    // A missing path is a legitimate deletion/rename origin, never an ignored change.
    if (!guard.ok) throw new Error('actual scope path cannot be verified');
  }
}
module.exports = { parsePattern, parsePaths, pathMatches, taskForbiddenDeclaration, snapshotInputs, verifyTouchedPaths };
