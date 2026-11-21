'use strict';
// Shared author-lineage reader: launch records and the writer labels of package journals.
const fs = require('node:fs');
const path = require('node:path');
const { reportPath } = require('../../.ai/bin/lib/author-report.cjs');
const { maskMarkdown } = require('../../.ai/bin/lib/text-safe.cjs');
const FAMILIES = [['claude', /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/i], ['gpt', /\b(?:gpt|codex|openai|sol)\b/i], ['gemini', /\b(?:gemini|argon)\b/i],
  ['glm', /\b(?:glm|zhipu)\b/i], ['deepseek', /\bdeepseek\b/i], ['kimi', /\b(?:kimi|moonshot)\b/i], ['mimo', /\b(?:mimo|xiaomi)\b/i], ['minimax', /\bminimax\b/i],
  ['qwen', /\bqwen\b/i], ['mistral', /\bmistral\b/i], ['copilot', /\bcopilot\b/i]];
const spacedOf = text => String(text === undefined || text === null ? '' : text).replace(/[-_./:]+/g, ' ');
function familyOf(text) {
  const spaced = spacedOf(text);
  const hit = FAMILIES.find(([, re]) => re.test(spaced));
  return hit ? hit[0] : null;
}
// A provider/model id is one word with one forward slash and no file extension after it; any other token with a slash is a path.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FILE_NAME = /\.(?:md|cjs|mjs|js|json|jsonl|txt|ps1|sh|ts|yml|yaml|toml|cmd|log)$/i;
const isModelId = token => MODEL_ID.test(token.replace(/^[(['"`]+|[)\]'"`,;:.]+$/g, '')) && !FILE_NAME.test(token.replace(/[)\]'"`,;:]+$/, ''));
// Every family a piece of text names. A provider/model id names its family as familyOf reads it; any other token with a slash is a
// path and names no family; a bare hyphenated label such as kimi-tasks still names Kimi conservatively.
function familiesOf(text) {
  const spaced = spacedOf(String(text === undefined || text === null ? '' : text).replace(/\S*[\\/]\S*/g, token => (isModelId(token) ? token : ' ')));
  return FAMILIES.filter(([, re]) => re.test(spaced)).map(([name]) => name);
}
const AUTHOR_LINE = /^[ \t>*_-]*(?:Автор|Author)[ \t*_]*:(.*)$/i;
// A role that shaped a round: an item of the writer line (between commas, semicolons and parentheses) that starts with it ("role AUTHOR",
// "round NAME author") or says "as the author". "certifier, not author", "не автор", "author report reader" and a line that only reads
// the author journals of others are no role.
const ROLE_NAME = '(?:author|автор|implementer|merger|aborted merge|merge|fixer)(?![\\p{L}\\p{N}])(?!\\s+report)';
const ROLE_ITEM = new RegExp(`^(?:role\\s+|round\\s+\\S+\\s+)?(?:as\\s+)?(?:an?\\s+|the\\s+)?${ROLE_NAME}|(?<![\\p{L}\\p{N}])as\\s+(?:an?\\s+|the\\s+)?${ROLE_NAME}`, 'iu');
const hasRole = segment => String(segment).split(/[(),;]/).some(item => ROLE_ITEM.test(item.trim()));
// The segments of a writer line, split at a comma or semicolon outside parentheses.
function segmentsOf(agent) {
  const out = []; let depth = 0, from = 0;
  for (let i = 0; i < agent.length; i++) {
    const c = agent[i];
    if (c === '(') depth++; else if (c === ')') depth = Math.max(0, depth - 1);
    else if ((c === ',' || c === ';') && depth === 0) { out.push(agent.slice(from, i)); from = i + 1; }
  }
  out.push(agent.slice(from));
  return out;
}
// The writer of a journal entry: the segments of its Agent line up to and including the first that gives a role in the round (the
// client, the model and the role stand there; a session, a task or a review the writer read stand after). No such segment: no round.
function writerOf(agent) {
  const taken = [];
  for (const segment of segmentsOf(String(agent))) {
    taken.push(segment);
    if (hasRole(segment)) return taken.join(' ');
  }
  return null;
}
// The family of a launch record: its model, else its client when the client is no route.
function recordFamily(record) {
  const named = value => (typeof value === 'string' ? value : '');
  return familyOf(named(record.model)) || (/^(?:kilo|cline)$/i.test(named(record.client)) ? null : familyOf(named(record.client)));
}
// The launches of the package that wrote a round: the seat records (`NAME.running.json`, `NAME.terminal.json`) the launcher keeps in the
// runtime folder, whose stream is a name of the package and whose launch was no certifier and no pre-review.
function seatFamilies(runtimeDir, names) {
  const found = [];
  let files = [];
  try { files = fs.readdirSync(runtimeDir).filter(n => /\.(?:running|terminal)\.json$/.test(n)).sort(); } catch { return found; }
  const mention = names.map(n => `"${n}"`);
  for (const file of files) {
    const text = read(path.join(runtimeDir, file));
    if (text === null || !mention.some(m => text.toLowerCase().includes(m))) continue;
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    if (!record || typeof record !== 'object' || record.certifier !== false || ['certifier', 'pre-review'].includes(record.launchRole)) continue;
    const stream = typeof record.stream === 'string' && names.includes(record.stream.toLowerCase());
    const family = stream && recordFamily(record);
    if (family) found.push([family, file]);
  }
  return found;
}
// The lines the document itself states: a fenced example or a quotation is not a statement of the document. Inline code and a link are
// part of a statement (a title names its package in code); an HTML comment or tag inside a line is not.
const STATED_SPANS = new Set(['code-span', 'inline-link']);
function ownText(text) {
  const plain = String(text).replace(/^\uFEFF/, '');
  try {
    const masked = maskMarkdown(plain);
    return masked.lines.filter(l => !l.masked).map(l => {
      if (!l.partial) return l.text;
      const cuts = masked.spans.filter(s => !STATED_SPANS.has(s.kind) && s.startLine <= l.line && l.line <= s.endLine)
        .map(s => [s.startLine === l.line ? s.startCol : 0, s.endLine === l.line ? s.endCol : l.text.length]).sort((a, b) => a[0] - b[0]);
      let out = '', at = 0;
      for (const [from, to] of cuts) { if (to <= at) continue; out += `${l.text.slice(at, Math.max(from, at))} `; at = to; }
      return out + l.text.slice(at);
    });
  } catch { return plain.split(/\r?\n/); }
}
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A title names a package only by its whole id; a longer id or a version suffix names another package.
const namesPackage = (title, names) => names.some(n => new RegExp(`(?<![A-Za-z0-9-])${escapeRe(n)}(?![A-Za-z0-9]|-[A-Za-z0-9]|\\.[0-9])`, 'i').test(title));

// The families that authored a round of the package, each with the file that says so: the seat records of its author launches
// (`runtimeDir`), every "Автор:" or "Author:" line the author report of a name of the package states, and the writer of every journal
// entry that names the package in its title and gives its writer a role in the round. The names of the package: the stream, the branch,
// the branch without its ops- prefix, and the streams of the candidate rows that hold the branch or the head (`names`).
function authorLineage(root, { stream, branch, names: more, runtimeDir, structuredOnly = false } = {}) {
  const found = new Map();
  const add = (families, source) => { for (const family of families) found.set(family, [...(found.get(family) || []), source]); };
  const stripped = typeof branch === 'string' ? branch.replace(/^ops-/i, '') : null;
  const names = [...new Set([stream, branch, stripped, ...(Array.isArray(more) ? more : [])].filter(n => typeof n === 'string' && n).map(n => n.toLowerCase()))];
  if (typeof runtimeDir === 'string' && runtimeDir && names.length) for (const [family, file] of seatFamilies(runtimeDir, names)) add([family], `seat record ${file}`);
  for (const name of structuredOnly ? [] : names) {
    let rel = null;
    try { rel = reportPath(name); } catch { rel = null; }
    const report = rel ? read(path.join(root, rel)) : null;
    if (report === null) continue;
    for (const text of ownText(report)) {
      const line = AUTHOR_LINE.exec(text);
      if (line) add(familiesOf(line[1]), rel);
    }
  }
  const dir = path.join(root, '.ai', 'worklog');
  let journals = [];
  try { journals = fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').sort(); } catch { journals = []; }
  for (const name of journals) {
    const text = read(path.join(dir, name));
    if (text === null) continue;
    for (const entry of ownText(text).join('\n').split(/^(?=## )/m)) {
      const title = (/^## (.*)$/m.exec(entry) || [])[1];
      const agent = (/^Agent:[ \t]*(.*)$/m.exec(entry) || [])[1];
      const writer = title && agent && namesPackage(title, names) ? writerOf(agent) : null;
      if (writer !== null) add(familiesOf(writer), `.ai/worklog/${name}`);
    }
  }
  return found;
}
module.exports = { familyOf, familiesOf, authorLineage };
