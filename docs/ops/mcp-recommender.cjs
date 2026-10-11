'use strict';
// Project reader for the MCP recommender skill (PROTO-DEC-0170 item 2). It reads ONE project directory, detects the stack, the
// MCP servers and skills the project already has, and prints a ranked shortlist of 3-5 OPTIONAL MCP servers and skills from
// docs/ops/mcp-catalog.json. It only reads: nothing is installed, started, downloaded or written, and no network is used.
//
//   node docs/ops/mcp-recommender.cjs [PROJECT_DIR] [--catalog FILE] [--max N] [--json]
//
// OFFER RULE: only an entry whose provenance is exactly "host-config", that is not marked verified:false or unverified, whose pin is
// exact (pinKind version: MAJOR.MINOR.PATCH; pinKind revision: 40-hex; no range, tag or bare name), whose install text contains that
// pin verbatim as exactly one token of a plain command (character whitelist, no prose; see installProblem) and has no
// placeholder is ever ranked or offered. Every other entry is listed apart as "not
// verified, not offered" with the reason, in the text and in --json.
// The mandatory minimum (serena, codebase-memory, qmd) is never offered. A server that needs a secret is never listed without
// the line "NEEDS SECRET: <ENV NAME>" (or the OAuth line), and ranks below comparable keyless servers. Exit 0: a shortlist was
// printed (it may hold fewer than 3 when fewer are relevant, and says so). Exit 2: bad usage, unreadable project or bad catalog.
const fs = require('node:fs');
const path = require('node:path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'target', 'out', 'venv', '.venv', 'env', '__pycache__', '.next', '.nuxt', '.svelte-kit', 'vendor', '.dart_tool', 'Library', 'Temp', 'Intermediate', 'Binaries', 'DerivedData', '.gradle', 'coverage']);
const CODE_EXT = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.py', '.rs', '.go', '.php', '.java', '.kt', '.cs', '.rb', '.dart', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp', '.gd']);
const WEB_EXT = new Set(['.html', '.htm', '.css', '.scss']);
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 3;
const HAS_SECRET = new Set(['yes', 'oauth']);
const NEEDS = ['no', 'yes', 'oauth'];

function parseArgs(argv) {
  const o = { dir: '', catalog: '', max: 5, json: false };
  const need = (i, n) => { if (i + 1 >= argv.length) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--catalog') { o.catalog = need(i, a); i++; }
    else if (a.startsWith('--catalog=')) o.catalog = a.slice(10);
    else if (a === '--max') { o.max = Number(need(i, a)); i++; }
    else if (a.startsWith('--max=')) o.max = Number(a.slice(6));
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
    else if (!o.dir) o.dir = a;
    else throw new Error(`unexpected extra argument: ${a}`);
  }
  if (!Number.isInteger(o.max) || o.max < 3 || o.max > 5) throw new Error('--max must be an integer from 3 to 5');
  return o;
}

function findCatalog(explicit) {
  const cands = explicit ? [path.resolve(explicit)] : [path.join(__dirname, 'mcp-catalog.json')];
  for (const c of cands) if (fs.existsSync(c)) return c;
  throw new Error(`catalog not found: ${cands[0]}`);
}

function loadCatalog(file) {
  let c;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error(`catalog is not valid JSON: ${file}`); }
  if (!c || c.schema !== 'mcp-catalog/1' || !Array.isArray(c.entries) || !Array.isArray(c.mandatory)) throw new Error('catalog schema must be mcp-catalog/1 with "mandatory" and "entries"');
  const seen = new Set();
  c.invalid = [];
  for (const e of c.entries) {
    const bad = m => { throw new Error(`catalog entry ${e && e.name}: ${m}`); };
    if (!e || typeof e.name !== 'string' || !e.name) throw new Error('catalog entry without a name');
    if (seen.has(e.name)) bad('duplicate name');
    seen.add(e.name);
    if (!['mcp', 'skill'].includes(e.kind)) bad('kind must be mcp or skill');
    if (typeof e.purpose !== 'string' || !e.purpose) bad('purpose is empty');
    if (!Array.isArray(e.tags) || !e.tags.length) bad('tags must be a non-empty array');
    if (!NEEDS.includes(e.needsSecret)) bad(`needsSecret must be one of ${NEEDS.join(', ')}`);
    if (e.needsSecret === 'yes' && !e.secretEnv) bad('needsSecret yes requires secretEnv (the variable NAME, never a value)');
    if (!['local', 'remote'].includes(e.transport)) bad('transport must be local or remote');
    if (e.install === null) { if (typeof e.pin !== 'string' || !/^unverified/i.test(e.pin)) bad('install null requires a pin that starts with "unverified"'); }
    else if (typeof e.install !== 'string' || !e.install) bad('install note is empty (use null with an "unverified" pin when no verified install is known)');
    // F-004: an entry with an install text whose pin is not exact, or not used verbatim by the install, is loaded but never offered.
    if (e.note !== undefined && typeof e.note !== 'string') bad('note must be a string');
    if (typeof e.install === 'string') { const why = pinProblem(e); if (why) c.invalid.push({ name: e.name, kind: e.kind, reason: why }); }
  }
  return c;
}

// ---- project reading ----
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}
function walk(root) {
  const files = [];
  const dirs = [];
  let count = 0;
  const rec = (dir, depth) => {
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      if (count++ > MAX_ENTRIES) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        dirs.push(rel);
        if (depth < MAX_DEPTH) rec(full, depth + 1);
      } else if (e.isFile()) files.push(rel);
    }
  };
  rec(root, 1);
  return { files, dirs, truncated: count > MAX_ENTRIES };
}
const norm = n => String(n).toLowerCase().replace(/_/g, '-');

function tomlMcpNames(text) {
  const names = new Set();
  for (const m of text.matchAll(/^\s*\[mcp_servers\.("?)([A-Za-z0-9_-]+)\1(?:\.[^\]]*)?\]/gm)) names.add(norm(m[2]));
  return [...names];
}

const DEP_RULES = [
  [/^react(-dom)?$/, ['react', 'web-frontend']],
  [/^next$/, ['nextjs', 'react', 'web-frontend']],
  [/^(vue|nuxt|svelte|@sveltejs\/kit|astro|vite|@angular\/core|solid-js|preact|remix|@remix-run\/react)$/, ['web-frontend']],
  [/^(tailwindcss|@tailwindcss\/.+)$/, ['tailwind', 'web-frontend']],
  [/^(express|fastify|koa|hono|@nestjs\/core|@hapi\/hapi|restify)$/, ['backend', 'api']],
  [/^(prisma|@prisma\/client|drizzle-orm|typeorm|mongoose|pg|mysql2|sequelize|knex|better-sqlite3|mongodb|redis|ioredis)$/, ['database', 'backend']],
  [/^(playwright|@playwright\/test|cypress|puppeteer|puppeteer-core|webdriverio|selenium-webdriver)$/, ['browser-testing']],
  [/^@modelcontextprotocol\/sdk$/, ['mcp-server']],
  [/^(electron|react-native|expo)$/, ['web-frontend']],
];
const PY_RULES = [
  [/^(django|flask|fastapi|starlette|aiohttp|tornado|sanic|litestar)$/, ['backend', 'api']],
  [/^(sqlalchemy|psycopg2?(-binary)?|psycopg|asyncpg|pymongo|alembic|peewee|tortoise-orm|sqlmodel|motor)$/, ['database', 'backend']],
  [/^(playwright|selenium|pytest-playwright)$/, ['browser-testing']],
  [/^mcp$/, ['mcp-server']],
];

// Returns { tags: Set, evidence: [{tag, why}], facts }
function readProject(dir) {
  const tags = new Map(); // tag -> first reason
  const add = (tag, why) => { if (!tags.has(tag)) tags.set(tag, why); };
  const w = walk(dir);
  const has = f => w.files.includes(f);
  const anyFile = re => w.files.find(f => re.test(f));
  const stacks = [];

  const pkg = has('package.json') ? readJson(path.join(dir, 'package.json')) : null;
  if (has('package.json')) {
    stacks.push('node');
    add('node', 'package.json'); add('any-code', 'package.json');
    const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.peerDependencies || {}) } : {};
    for (const d of Object.keys(deps)) for (const [re, ts] of DEP_RULES) if (re.test(d)) for (const t of ts) add(t, `package.json dependency ${d}`);
    const scripts = pkg && pkg.scripts ? Object.keys(pkg.scripts) : [];
    if (scripts.some(s => /^(e2e|test:e2e|playwright|cypress)/.test(s))) add('browser-testing', 'package.json e2e script');
  }
  if (has('components.json')) { add('shadcn', 'components.json'); add('react', 'components.json'); add('web-frontend', 'components.json'); }
  const pyFiles = ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].filter(has).concat(w.files.filter(f => /^requirements[^/]*\.txt$/.test(f) && f !== 'requirements.txt'));
  if (pyFiles.length) {
    stacks.push('python');
    add('python', pyFiles[0]); add('any-code', pyFiles[0]);
    const text = pyFiles.map(f => readText(path.join(dir, f))).join('\n').toLowerCase();
    const names = new Set([...text.matchAll(/(?:^|[\s"'\[,(])([a-z][a-z0-9_.-]*)(?=\s*(?:[=<>!~;\[\]"',)]|$))/gm)].map(m => m[1].replace(/_/g, '-')));
    for (const n of names) for (const [re, ts] of PY_RULES) if (re.test(n)) for (const t of ts) add(t, `Python dependency ${n}`);
  }
  if (has('Cargo.toml')) { stacks.push('rust'); add('rust', 'Cargo.toml'); add('any-code', 'Cargo.toml'); }
  if (has('go.mod')) { stacks.push('go'); add('go', 'go.mod'); add('any-code', 'go.mod'); add('backend', 'go.mod (heuristic)'); }
  if (has('composer.json')) { stacks.push('php'); add('php', 'composer.json'); add('any-code', 'composer.json'); add('backend', 'composer.json (heuristic)'); }
  if (has('Gemfile')) { stacks.push('ruby'); add('any-code', 'Gemfile'); add('backend', 'Gemfile (heuristic)'); }
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) { stacks.push('jvm'); add('any-code', 'Maven/Gradle build'); add('backend', 'Maven/Gradle build (heuristic)'); }
  const dotnet = anyFile(/\.(csproj|sln)$/);
  if (dotnet) { stacks.push('dotnet'); add('any-code', dotnet); add('backend', `${dotnet} (heuristic)`); }
  if (has('pubspec.yaml')) {
    const t = readText(path.join(dir, 'pubspec.yaml'));
    stacks.push(/flutter/i.test(t) ? 'flutter' : 'dart');
    add('dart', 'pubspec.yaml'); add('any-code', 'pubspec.yaml');
    if (/flutter/i.test(t)) add('flutter', 'pubspec.yaml mentions flutter');
  }
  if (anyFile(/(^|\/)ProjectSettings\/ProjectVersion\.txt$/)) { stacks.push('unity'); add('game', 'Unity ProjectSettings'); add('any-code', 'Unity project'); }
  if (anyFile(/\.uproject$/)) { stacks.push('unreal'); add('game', 'Unreal .uproject'); add('any-code', 'Unreal project'); }
  if (has('project.godot')) { stacks.push('godot'); add('game', 'project.godot'); add('any-code', 'Godot project'); }

  const ext = f => path.extname(f).toLowerCase();
  const codeFiles = w.files.filter(f => CODE_EXT.has(ext(f)));
  const webFiles = w.files.filter(f => WEB_EXT.has(ext(f)));
  const mdFiles = w.files.filter(f => ext(f) === '.md' || ext(f) === '.mdx' || ext(f) === '.rst' || ext(f) === '.txt');
  if (codeFiles.length) add('any-code', `${codeFiles.length} source file(s)`);
  const manifestStack = stacks.length > 0;
  if (webFiles.length && !manifestStack && !codeFiles.length) { stacks.push('static-site'); add('static-site', `${webFiles.length} HTML/CSS file(s), no build manifest`); add('web-frontend', 'static HTML/CSS pages'); }
  else if (webFiles.length) add('web-frontend', `${webFiles.length} HTML/CSS file(s)`);
  if (!manifestStack && !codeFiles.length && !webFiles.length && mdFiles.length) { stacks.push('docs-only'); add('docs-only', `${mdFiles.length} text/Markdown file(s), no code`); }

  if (anyFile(/\.sql$/) || w.dirs.some(d => /(^|\/)(migrations|prisma)$/.test(d))) add('database', 'SQL files or a migrations/prisma directory');
  if (anyFile(/(^|\/)(docker-)?compose[^/]*\.ya?ml$/) && /postgres|mysql|mariadb|mongo|redis/i.test(readText(path.join(dir, anyFile(/(^|\/)(docker-)?compose[^/]*\.ya?ml$/))))) add('database', 'compose file names a database image');
  if (anyFile(/(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i)) { add('api', 'OpenAPI/Swagger file'); add('backend', 'OpenAPI/Swagger file'); }
  if (w.dirs.includes('.github/workflows')) add('cicd', '.github/workflows');
  add('any-project', 'every project');

  // Existing servers and skills
  const configured = new Set();
  const sources = [];
  const mcpJson = has('.mcp.json') ? readJson(path.join(dir, '.mcp.json')) : null;
  if (mcpJson && mcpJson.mcpServers && typeof mcpJson.mcpServers === 'object') { sources.push('.mcp.json'); for (const n of Object.keys(mcpJson.mcpServers)) configured.add(norm(n)); }
  const vscode = has('.vscode/mcp.json') ? readJson(path.join(dir, '.vscode/mcp.json')) : null;
  if (vscode && vscode.servers && typeof vscode.servers === 'object') { sources.push('.vscode/mcp.json'); for (const n of Object.keys(vscode.servers)) configured.add(norm(n)); }
  if (has('.codex/config.toml')) { const n = tomlMcpNames(readText(path.join(dir, '.codex/config.toml'))); if (n.length) sources.push('.codex/config.toml'); n.forEach(x => configured.add(x)); }
  const skillDirs = [];
  const skills = new Set();
  for (const sd of ['skills', '.claude/skills', '.agents/skills']) {
    if (!w.dirs.includes(sd)) continue;
    skillDirs.push(sd);
    for (const f of w.files) {
      if (!f.startsWith(`${sd}/`)) continue;
      const parts = f.slice(sd.length + 1).split('/');
      if (parts.length === 1 && ext(parts[0]) === '.md') skills.add(norm(parts[0].replace(/\.md$/i, '')));
      else if (parts.length >= 2 && /^skill\.md$/i.test(parts[parts.length - 1])) skills.add(norm(parts[0]));
    }
  }
  // Measured schema costs the project already recorded in docs/MCP-PROJECT.md: | server | tokens | date | command |
  const measured = new Map();
  if (has('docs/MCP-PROJECT.md')) {
    for (const line of readText(path.join(dir, 'docs/MCP-PROJECT.md')).split('\n')) {
      const c = line.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
      if (c.length >= 4 && /^~?\d+$/.test(c[1]) && /^[A-Za-z0-9._-]+$/.test(c[0])) measured.set(norm(c[0]), { tokens: Number(c[1].replace('~', '')), date: c[2] });
    }
  }
  return { tags, stacks, configured, configuredSources: sources, skills, skillDirs, measured, truncated: w.truncated };
}

// ---- offer filter (runs BEFORE ranking and before the menu) ----
const PLACEHOLDER = /<[^<>\r\n]+>|\bchoose\b|\blatest\b|\bat install\b|\bTBD\b/i;
const PKG = '(?:@?[A-Za-z0-9][A-Za-z0-9._/-]*)';
const PIN_VERSION = new RegExp(String.raw`^${PKG}(?:@|==)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`);
const PIN_REVISION = new RegExp(String.raw`^(?:${PKG}@)?[0-9a-f]{40}$`);
const INSTALL_CHARS = /^[A-Za-z0-9._@/:=+ -]+$/;
const VERSION_LIKE = /\d\.\d/;
const RANGE_PATTERN = /^(?:-|x|latest|next)$|[@=](?:x|latest|next)$/i;
function installProblem(install, pin) {
  if (!INSTALL_CHARS.test(install)) return 'install text holds a character outside [A-Za-z0-9._@/:=+ -] (a quote, | & ; < > ( ) $, a backtick, backslash, comma, tab or newline); install must be a plain command, prose goes to "note"';
  const tokens = install.split(' ');
  if (tokens.some(t => t === '')) return 'install text must be single-space separated tokens without leading, trailing or doubled spaces';
  if (tokens.filter(t => t === pin).length !== 1) return `install command does not contain the pin ${JSON.stringify(pin)} verbatim as exactly one whole token`;
  for (const t of tokens) {
    if (t === pin) continue;
    if (VERSION_LIKE.test(t)) return `install command holds a second version-like token ${JSON.stringify(t)}`;
    if (RANGE_PATTERN.test(t)) return `install command holds a range or tag token ${JSON.stringify(t)}`;
  }
  return null;
}
// Returns null when pin and install satisfy the contract, otherwise the reason. Used by notOfferedReason and by loadCatalog.
function pinProblem(e) {
  if (typeof e.pin !== 'string' || !e.pin.trim()) return 'no pin';
  if (/^unverified/i.test(e.pin)) return 'pin is unverified; the operator must record a verified version first';
  if (e.pinKind !== 'version' && e.pinKind !== 'revision') return `pinKind is ${JSON.stringify(e.pinKind)}; only an exact version or a 40-hex revision is offerable (hosted, builtin and unverified entries have no exact pin)`;
  const re = e.pinKind === 'version' ? PIN_VERSION : PIN_REVISION;
  if (!re.test(e.pin)) return `pin ${JSON.stringify(e.pin)} is not an exact ${e.pinKind === 'version' ? 'MAJOR.MINOR.PATCH version (the package==MAJOR.MINOR.PATCH form)' : '40-hex lowercase revision'} (no range, tag or bare package name)`;
  if (typeof e.install !== 'string' || !e.install.trim()) return 'no install command';
  return installProblem(e.install, e.pin);
}
// Returns null when the entry may be offered, otherwise the reason it may not.
function notOfferedReason(e) {
  if (e.provenance === undefined || e.provenance === null || e.provenance === '') return 'provenance is missing';
  if (e.provenance !== 'host-config') return `provenance is ${JSON.stringify(e.provenance)}, not host-config (not seen in a client config on the operator host)`;
  if (e.verified === false) return 'marked verified:false';
  if (e.unverified === true || (typeof e.verified === 'string' && /unverified/i.test(e.verified))) return 'marked unverified';
  const pin = pinProblem(e);
  if (pin) return pin;
  if (PLACEHOLDER.test(e.install) || PLACEHOLDER.test(e.pin)) return 'install or pin text holds a placeholder';
  return null;
}

// ---- ranking ----
function rank(project, catalog, max) {
  const mandatory = new Set(catalog.mandatory.map(norm));
  const out = [];
  const skipped = [];
  const notVerified = [];
  const hasCode = project.tags.has('any-code');
  for (const e of catalog.entries) {
    const n = norm(e.name);
    if (mandatory.has(n)) continue;
    const why = notOfferedReason(e);
    if (why) { notVerified.push({ name: e.name, kind: e.kind, reason: why }); continue; }
    if (e.kind === 'mcp' && project.configured.has(n)) { skipped.push({ name: e.name, why: 'already configured in the project' }); continue; }
    if (e.kind === 'skill' && project.skills.has(n)) { skipped.push({ name: e.name, why: 'already present in a skills directory' }); continue; }
    const matched = e.tags.filter(t => project.tags.has(t));
    const specific = matched.filter(t => t !== 'any-code' && t !== 'any-project');
    if (!matched.length) continue;
    if (!specific.length && matched.includes('any-code') && !hasCode) continue;
    let score = e.weight + 4 * specific.length + (matched.includes('any-code') || matched.includes('any-project') ? 1 : 0);
    if (e.needsSecret === 'yes') score -= 3;
    else if (e.needsSecret === 'oauth') score -= 1;
    if (e.transport === 'remote') score -= 1;
    const m = project.measured.get(n);
    out.push({
      name: e.name, kind: e.kind, score, purpose: e.purpose, matched: matched.map(t => ({ tag: t, because: project.tags.get(t) })),
      transport: e.transport, network: e.network || 'unknown', needsSecret: e.needsSecret, secretEnv: e.secretEnv || null,
      install: e.install, note: e.note || null, pin: e.pin, provenance: e.provenance,
      cost: m ? { tokens: m.tokens, measuredOn: m.date, source: 'docs/MCP-PROJECT.md' } : { tokens: null },
    });
  }
  out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  // At most 3 of one kind among the first 4, so the menu mixes servers and skills when both fit; then cut to max.
  const picked = [];
  for (const kind of ['mcp', 'skill']) {
    const cap = kind === 'mcp' ? max : 2;
    picked.push(...out.filter(x => x.kind === kind).slice(0, cap));
  }
  picked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { shortlist: picked.slice(0, max), skipped, notVerified };
}

function flags(r) {
  const f = [r.transport === 'remote' ? 'REMOTE (hosted service)' : 'LOCAL process'];
  if (r.network === 'runtime') f.push('network at runtime');
  if (r.needsSecret === 'yes') f.push(`NEEDS SECRET: ${r.secretEnv} (the user sets it in the client environment; never stored in the repository)`);
  else if (r.needsSecret === 'oauth') f.push('NEEDS SECRET: OAuth sign-in by the user in the client (no key in the repository)');
  return f;
}

function render(dir, project, catalog, res, max) {
  const lines = [];
  lines.push(`PROJECT ${dir}`);
  lines.push(`STACK ${project.stacks.length ? project.stacks.join(', ') : 'unknown'}`);
  lines.push(`TAGS ${[...project.tags.keys()].filter(t => t !== 'any-project').join(', ') || '-'}`);
  lines.push(`CONFIGURED MCP ${project.configured.size ? `${[...project.configured].join(', ')} (from ${project.configuredSources.join(', ')})` : 'none found'}`);
  lines.push(`SKILLS ${project.skillDirs.length ? `${project.skillDirs.join(', ')}: ${[...project.skills].join(', ') || 'no skill files'}` : 'no skills directory found'}`);
  lines.push(`MANDATORY (always provided, never offered as an extra): ${catalog.mandatory.join(', ')}`);
  if (project.truncated) lines.push('NOTE the project is large; only the first entries of a bounded scan were read');
  lines.push(`SHORTLIST ${res.shortlist.length} of at most ${max}${res.shortlist.length < 3 ? ' (fewer than 3 are relevant to this project; nothing is added to fill the list)' : ''}`);
  res.shortlist.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.name} [${r.kind}] score=${r.score}`);
    lines.push(`   why: ${r.purpose}; fits: ${r.matched.filter(m => m.tag !== 'any-project').map(m => `${m.tag} (${m.because})`).join('; ') || 'any project'}`);
    lines.push(`   flags: ${flags(r).join(' | ')}`);
    lines.push(`   cost: ${r.cost.tokens !== null ? `~${r.cost.tokens} tokens, measured ${r.cost.measuredOn} (${r.cost.source})` : 'not measured; measure with docs/ops/mcp-schema-budget.cjs after the user installs it'}`);
    lines.push(`   install note: ${r.install} | pin: ${r.pin} | source: ${r.provenance}`);
    if (r.note) lines.push(`   note: ${r.note}`);
  });
  for (const s of res.skipped) lines.push(`SKIPPED ${s.name}: ${s.why}`);
  if (res.notVerified.length) {
    lines.push(`NOT VERIFIED, NOT OFFERED ${res.notVerified.length} catalog entr${res.notVerified.length === 1 ? 'y' : 'ies'} (never ranked, never shown as an install command)`);
    for (const v of res.notVerified) lines.push(`   ${v.name} [${v.kind}]: ${v.reason}`);
  }
  lines.push('NOTE nothing was installed or started. The user chooses from this list; the choice is recorded in docs/MCP-PROJECT.md.');
  lines.push(`RESULT exit=0 shortlist=${res.shortlist.length}`);
  return lines.join('\n');
}

function run(argv, io = {}) {
  const out = io.out || (s => process.stdout.write(`${s}\n`));
  const err = io.err || (s => process.stderr.write(`${s}\n`));
  let o;
  try { o = parseArgs(argv); } catch (e) {
    err(`mcp-recommender: ${e.message}`);
    err('usage: node docs/ops/mcp-recommender.cjs [PROJECT_DIR] [--catalog FILE] [--max 3..5] [--json]');
    return 2;
  }
  const dir = path.resolve(o.dir || process.cwd());
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
  } catch { err(`mcp-recommender: cannot read project directory: ${dir}`); return 2; }
  let catalog;
  try { catalog = loadCatalog(findCatalog(o.catalog)); } catch (e) { err(`mcp-recommender: ${e.message}`); return 2; }
  const project = readProject(dir);
  const res = rank(project, catalog, o.max);
  if (o.json) {
    out(JSON.stringify({
      tool: 'mcp-recommender', project: dir, stacks: project.stacks, tags: [...project.tags.keys()].filter(t => t !== 'any-project'),
      configuredMcp: [...project.configured], skills: [...project.skills], mandatory: catalog.mandatory, shortlist: res.shortlist, skipped: res.skipped, notVerified: res.notVerified,
      installed: false,
    }, null, 2));
  } else out(render(dir, project, catalog, res, o.max));
  return 0;
}

if (require.main === module) process.exit(run(process.argv.slice(2)));
module.exports = { run, readProject, rank, loadCatalog, parseArgs, notOfferedReason, pinProblem, installProblem };
