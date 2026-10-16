'use strict';
// One identity grammar for a model spelling. Identity only: closed registry
// data, never a claim about the served model. Every spelling the repository
// uses for one model resolves here and nowhere else:
//   model-aliases.json  routeAliases (route model and catalog id), idEquivalents, makerRules
//   clients.json        launchAliases (the enforced launch spelling, vibe glm-5-3 for zai-glm-5-3)
//   model-identity-data.json  launch-record ids that no registry list names
// A spelling the data does not name is UNKNOWN, never a pass and never a guess.
const rawData = require('../../../docs/product/launch-records/data/model-aliases.json');
const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('./text-safe.cjs');
const pathSafe = require('./path-safe.cjs');
// The client registry belongs to the project that owns it (P-L3-005). Absent (ENOENT) it names no launch alias, so an
// aliased spelling stays UNKNOWN there. Present, it is read like every other trusted project file: the guarded real path
// inside the project root (no link, junction, hardlink or non-regular file), the shared text decode (no BOM, no invisible
// character, valid UTF-8) and the unique-key JSON parse. Anything else throws a named error, never a silent fallback.
// It is read from disk, not required, so an installed kit never pulls the development registry along.
// PILOT-FIX round 3 (Q2): the project root comes from the caller, never from where this module file sits. Node resolves a
// junction before __dirname is computed, so a module reached through a linked .ai would name the link target as its own
// root. The root is the explicit MODEL_IDENTITY_ROOT or else the working directory, both resolved with realpath; the
// registry must then be real-path inside it.
const refusal = (code, detail) => Object.assign(new Error(`model-identity: ${code}: ${detail}`), { code });
function projectRoot() {
  const given = process.env.MODEL_IDENTITY_ROOT;
  if (given !== undefined && (typeof given !== 'string' || given === '' || !path.isAbsolute(given))) throw refusal('REGISTRY_ROOT', 'MODEL_IDENTITY_ROOT is not an absolute path');
  try { return fs.realpathSync.native(given === undefined ? process.cwd() : given); } catch (error) { throw refusal('REGISTRY_ROOT', `the project root cannot be resolved (${error.code || 'unknown'})`); }
}
// PILOT-FIX round 4 (G1): ONE closed grammar for a model spelling: lower-case ASCII letters and digits in runs joined by a single
// dot or dash, and at most one provider slash. Nothing else is a spelling: not another case, not a leading, trailing or doubled
// separator, not a colon, not a second slash, not any non-ASCII or control character. A value outside it is UNKNOWN before any
// lookup, and a registry key or alias outside it fails the load. There is no folding of free spellings anywhere (G2).
const SPELLING_GRAMMAR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/;
const MAX_SPELLING = 120;
const isSpelling = value => typeof value === 'string' && value.length <= MAX_SPELLING && SPELLING_GRAMMAR.test(value);
// The four spellings of the tracked alias data that the grammar excludes (a colon, a second slash). They are named whole and
// are inert: no input can equal them, so they resolve to UNKNOWN. Any other spelling outside the grammar fails the load.
const LEGACY_INERT = new Set(['kilo/qwen/qwen3.8-27b:free', 'kilo/stepfun/step-3.7-flash:free', 'kilo/nvidia/nemotron-3-super-120b-a12b:free', 'openai-compatible/deepseek/deepseek-v4-flash']);
// A name that is, or has as its provider or its model part, exactly a slot of Object.prototype is never a registry name.
// Exact parts only: nothing is folded, so constructor-latest or glm-prototype-x is an ordinary spelling, not a slot.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);
const reservedPart = value => value.split('/').some(part => RESERVED.has(part));
// PILOT-FIX round 3 (Q3): the registry is bounded before it is parsed and before any recursive walk of it.
const MAX_REGISTRY_BYTES = 1048576;
const MAX_JSON_DEPTH = 32;
// Linear scan of the JSON text for container depth; strings are skipped, so a bracket inside a string is not depth.
function checkJsonDepth(text, file) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++; } else if (c === '{' || c === '[') {
      if (++depth > MAX_JSON_DEPTH) throw refusal('REGISTRY_DEPTH', `${file} nests deeper than ${MAX_JSON_DEPTH} levels`);
    } else if (c === '}' || c === ']') depth--;
  }
}
// PILOT-FIX round 2 (P1) and round 4 (G4): registry data is closed data. At any depth, before any map is built from it, a key that
// is exactly a slot of Object.prototype is refused (REGISTRY_KEY) and every string, key and value alike, must be printable ASCII
// (REGISTRY_TEXT): the raw text was decoded before the parse, but a JSON escape is only a character after the parse, so the
// alphabet is decided here on the parsed strings. The maps built below are Object.create(null) or Map; lookups are Object.hasOwn.
const PRINTABLE = /^[\x20-\x7e]*$/;
function refuseData(value, file, where = '$', depth = 0) {
  if (typeof value === 'string') {
    if (!PRINTABLE.test(value)) throw refusal('REGISTRY_TEXT', `${file} has a string outside printable ASCII at ${where}`);
    return value;
  }
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_JSON_DEPTH) throw refusal('REGISTRY_DEPTH', `${file} nests deeper than ${MAX_JSON_DEPTH} levels`);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (RESERVED.has(key)) throw refusal('REGISTRY_KEY', `${file} has the forbidden key "${key}" at ${where}`);
    if (!PRINTABLE.test(key)) throw refusal('REGISTRY_TEXT', `${file} has a key outside printable ASCII at ${where}`);
    refuseData(value[key], file, `${where}.${key}`, depth + 1);
  }
  return value;
}
// A name the registry data spells as a model (an alias key or target, an id, a launch model) is in the grammar, or the load fails.
function refuseSpelling(value, file, inertAllowed) {
  if (typeof value !== 'string') throw refusal('REGISTRY_SPELLING', `${file} names a spelling that is not text`);
  if (inertAllowed && LEGACY_INERT.has(value)) return;
  if (reservedPart(value)) throw refusal('REGISTRY_KEY', `${file} names the forbidden spelling "${value.slice(0, 60)}"`);
  if (!isSpelling(value)) throw refusal('REGISTRY_SPELLING', `${file} names "${value.slice(0, 60).replace(/[^\x20-\x7e]/g, '?')}", which is outside the closed grammar`);
}
const bare = entries => Object.assign(Object.create(null), Object.fromEntries(entries));
// PILOT-FIX round 4 (G3): the registry file is read ONCE through the shared pinned reader (one open handle, the file identity and
// its real path checked on that handle, no check of the file before the read). Around it only the chosen root is held: its
// identity is taken before the read and compared after, so a root swapped for a link at any moment is refused, and the file the
// reader returns must lie inside the root the caller chose. Absence is asked only when the reader found no regular file.
function directoryId(dir) {
  const st = fs.lstatSync(dir, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink()) throw refusal('REGISTRY_ROOT', 'the project root is not a plain directory');
  return st;
}
const sameName = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function rootStill(root, before) {
  try {
    const after = directoryId(root);
    return after.dev === before.dev && after.ino === before.ino && sameName(fs.realpathSync.native(root), root);
  } catch { return false; }
}
function loadClients() {
  const root = projectRoot();
  const registryFile = path.join(root, '.ai', 'docs', 'clients.json');
  let before;
  try { before = directoryId(root); } catch (error) { throw error.code === 'REGISTRY_ROOT' ? error : refusal('REGISTRY_ROOT', `the project root cannot be read (${error.code || 'unknown'})`); }
  if (!sameName(fs.realpathSync.native(root), root)) throw refusal('REGISTRY_ROOT', 'the project root is not the chosen real path');
  const read = pathSafe.readFileGuarded(root, registryFile);
  if (!rootStill(root, before)) throw refusal('REGISTRY_ROOT', 'the project root changed while the registry was read');
  if (!read.ok) {
    let absent = false;
    if (read.reason === 'not-file') { try { fs.lstatSync(registryFile); } catch (error) { absent = error.code === 'ENOENT'; } }
    if (absent) return { clients: {} };
    throw refusal('REGISTRY_PATH', `${read.reason} (${read.detail})`);
  }
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!sameName(read.real.slice(0, rootPrefix.length), rootPrefix)) throw refusal('REGISTRY_ROOT', 'the registry was read from outside the chosen project root');
  if (read.bytes.length > MAX_REGISTRY_BYTES) throw refusal('REGISTRY_SIZE', `the registry is larger than ${MAX_REGISTRY_BYTES} bytes`);
  const decoded = textSafe.decode(read.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) throw refusal('REGISTRY_ENCODING', decoded.problems.map(p => p.code).join(','));
  checkJsonDepth(decoded.text, 'the client registry');
  let parsed;
  try { parsed = textSafe.parseJsonUnique(decoded.text); } catch (error) { throw refusal('REGISTRY_JSON', error.code || 'JSON_SYNTAX'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw refusal('REGISTRY_SHAPE', 'the root is not an object');
  if (!parsed.clients || typeof parsed.clients !== 'object' || Array.isArray(parsed.clients)) throw refusal('REGISTRY_SHAPE', 'clients.json has no clients object');
  refuseData(parsed, 'the client registry');
  for (const client of Object.values(parsed.clients)) {
    const aliases = client?.launchAliases;
    if (aliases === undefined) continue;
    if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases) || Object.values(aliases).some(launch => typeof launch !== 'string')) throw refusal('REGISTRY_SHAPE', 'launchAliases is not an object of strings');
    for (const [name, launch] of Object.entries(aliases)) { refuseSpelling(name, 'the client registry', false); refuseSpelling(launch, 'the client registry', false); }
  }
  return parsed;
}
const clients = loadClients();
const supplement = refuseData(require('./model-identity-data.json'), 'the launch supplement');
const data = refuseData(rawData, 'the alias data');
for (const [key, value] of Object.entries(data.idEquivalents || {})) { refuseSpelling(key, 'the alias data', true); refuseSpelling(value, 'the alias data', true); }
for (const alias of data.routeAliases || []) {
  refuseSpelling(alias.model, 'the alias data', true);
  if (alias.modelId !== null && alias.modelId !== undefined) refuseSpelling(alias.modelId, 'the alias data', true);
}
for (const row of supplement.launchModels || []) refuseSpelling(row.model, 'the launch supplement', false);
// Explicit equivalents only: a spelling the data names as another id, looked up once, never iterated and never inferred.
const idEquivalents = bare(Object.entries(data.idEquivalents || {}));
const dash = value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const lastSegment = value => value.split('/').at(-1);
function canonicalId(value) {
  const tail = lastSegment(value);
  return Object.hasOwn(idEquivalents, tail) && typeof idEquivalents[tail] === 'string' ? lastSegment(idEquivalents[tail]) : tail;
}
const index = new Map();
// The exact provider-qualified spellings the registry data itself names whole (a route such as cline-free/mimo-v2.6-flash or
// cerebras/qwen-3.8-27b). The data decides those. Any other value with a separator must be provider/model with the provider
// naming the maker of the model (canonicalModel).
const routes = new Set();
function add(name, id) {
  if (!isSpelling(name)) return;
  if (name.includes('/')) routes.add(name);
  const key = lastSegment(name);
  if (!index.has(key)) index.set(key, new Set());
  index.get(key).add(id);
}
for (const [key, value] of Object.entries(idEquivalents)) add(key, lastSegment(value));
for (const alias of data.routeAliases) {
  if (typeof alias.modelId !== 'string' || !isSpelling(alias.modelId)) continue;
  const id = canonicalId(alias.modelId);
  add(alias.model, id); add(alias.modelId, id);
}
for (const client of Object.values(clients.clients)) {
  const launchAliases = bare(Object.entries(client?.launchAliases || {}));
  for (const [name, launch] of Object.entries(launchAliases)) {
    const known = index.get(lastSegment(name));
    const id = known?.size === 1 ? [...known][0] : canonicalId(name);
    add(name, id); add(launch, id);
  }
}
for (const row of supplement.launchModels) add(row.model, canonicalId(row.model));
const MAKERS = (data.makerRules || []).map(rule => ({ re: new RegExp(rule.pattern, 'i'), family: dash(rule.maker) }));
const FAMILIES = new Set(MAKERS.map(rule => rule.family));
// The maker labels exactly as the closed rules spell them (Anthropic, Zhipu AI (Z.ai)) and their dash form: a declared family label.
const FAMILY_LABELS = new Set([...(data.makerRules || []).map(rule => rule.maker), ...FAMILIES]);
const makerFamily = id => MAKERS.find(rule => rule.re.test(id))?.family;
// Outside the spellings the registry names whole, a value is at most provider/model (the grammar allows one slash), and the
// provider of a pair must be the maker of the model per makerRules (xiaomi/gpt-6.1-sol is UNKNOWN, deepseek/deepseek-flash is not).
function pairRefused(value, id) {
  if (routes.has(value)) return false;
  const parts = value.split('/');
  return parts.length > 1 && parts[0] !== makerFamily(id);
}
function canonicalModel(value, { actor = false } = {}) {
  if (!isSpelling(value)) return 'UNKNOWN';
  const matches = index.get(lastSegment(value));
  if (matches?.size === 1 && pairRefused(value, [...matches][0])) return 'UNKNOWN';
  if (matches || !actor) return matches?.size === 1 ? [...matches][0] : 'UNKNOWN';
  // an actor token is filesystem safe: a separator names no actor
  if (value.includes('/')) return 'UNKNOWN';
  // Lineage serializes an actor identity as a filesystem-safe token: lower-case, every dot written as a dash. This decodes
  // that one fixed encoding through the same index and the same canonical result, not a second model identity rule, and it
  // strips no suffix. An opaque actor id (a family name plus a hex session token) names no model: it stays an exact identity
  // and never becomes a family prefix.
  const actorKey = value.replace(/\./g, '-');
  const found = new Set();
  for (const [key, ids] of index) {
    const safe = key.replace(/\./g, '-');
    if (actorKey === safe || actorKey.endsWith('-' + safe)) for (const id of ids) found.add(id);
  }
  return found.size === 1 ? [...found][0] : 'UNKNOWN';
}
const lineageModel = value => canonicalModel(value, { actor: true });
// Family = the maker of the canonical model, from the closed makerRules. Two
// spellings of one model, and two models of one maker, share a family.
function canonicalFamily(value, options) {
  const model = canonicalModel(value, options);
  if (model === 'UNKNOWN') return 'UNKNOWN';
  return MAKERS.find(rule => rule.re.test(model))?.family || 'UNKNOWN';
}
const lineageFamily = value => canonicalFamily(value, { actor: true });
// PILOT-FIX round 6 (J1): ONE positive rule for every lineage token, recognised or not. The forms below are the canonical dash forms
// of every known model: each id and each spelling the index holds, dots written as dashes (as the lineage encoding does). The set a
// token HOLDS is every known model whose form occurs in the token as a contiguous substring at any position, with no segment boundary
// required (gpt-5-6-sol-deepseek-flash holds gpt-5.6-sol and deepseek-flash, xgpt-5-6-sol holds gpt-5.6-sol). The set is computed from
// the registry data, never from a hand list. An empty set is an opaque actor id (a hex session token, gpt-5: a partial id is not a
// known model's complete form). The decoder above names one model per token and is never the whole answer.
const KNOWN_FORMS = new Map();
const idForm = id => id.replace(/\./g, '-');
// PILOT-FIX round 7 (J5): a token and a form are compared with every dot and dash removed from BOTH, so a separator doubled, moved or
// dropped (gpt--5-6-sol, gpt5-6sol, gpt56sol) still holds the model. The set is the union with the dash-form comparison of round 6.
const plainForm = form => form.replace(/[.-]/g, '');
// PILOT-FIX round 7 (J5'): the protocol owner name form is <agent>-<16 hex>. Before the separator-free comparison ONE final group
// -[0-9a-f]{16} is removed, so the hex tail cannot glue onto the agent name (an agent name followed by a hex tail that spells part of a model form holds no model).
// The dash-form comparison below still reads the WHOLE token unchanged.
const SESSION_SUFFIX = /-[0-9a-f]{16}$/;
for (const [key, ids] of index) {
  for (const id of ids) for (const form of [idForm(key), idForm(id)]) { if (!KNOWN_FORMS.has(form)) KNOWN_FORMS.set(form, new Set()); KNOWN_FORMS.get(form).add(id); }
}
function lineageHeldModels(value) {
  if (typeof value !== 'string' || value.length > MAX_SPELLING) return [];
  const dashToken = value.replace(/\./g, '-');
  const plainToken = plainForm(value.replace(SESSION_SUFFIX, ''));
  const held = new Set();
  for (const [form, ids] of KNOWN_FORMS) if (dashToken.includes(form) || plainToken.includes(plainForm(form))) for (const id of ids) held.add(id);
  return [...held].sort();
}
// The one model a token names whole: the decoder recognises it and no other known model, except a model whose form is only part of
// that model's form (claude-sonnet-5 inside claude-sonnet-5-5), is held. Anything else is not a plain model spelling.
function lineagePlainModel(value) {
  const decoded = lineageModel(value);
  if (decoded === 'UNKNOWN') return 'UNKNOWN';
  const held = lineageHeldModels(value);
  const whole = held.filter(id => !held.some(other => other !== id && idForm(other).includes(idForm(id))));
  return whole.length === 1 && whole[0] === decoded ? decoded : 'UNKNOWN';
}
// PILOT-FIX round 7 (J4): the ONE closed grammar of a lineage token: lower-case ASCII letters and digits in runs joined by a single dot or
// dash, no leading or trailing separator, within the length limit. A token outside it is refused before any set is computed.
const LINEAGE_TOKEN_GRAMMAR = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const lineageTokenInGrammar = value => typeof value === 'string' && value.length <= MAX_SPELLING && LINEAGE_TOKEN_GRAMMAR.test(value);
// PILOT-FIX round 7 (J7): the independence decision for one lineage token against a sealed certifier (its own model, and for Class A its
// family, else UNKNOWN). The token is reduced to its HELD SET; it is refused only when that set holds the certifier's own model or, for
// Class A, any model of the certifier's family. A non-empty set disjoint from both is accepted (the models it holds join the author
// families of Class A in tools/operator/seats.cjs); an empty set is an opaque id. Results: 'lineage-token-outside-grammar' (outside the
// closed lineage grammar), null (no refusal), 'non-independent-seat' (the token names exactly the certifier's own model) or
// 'unknown-lineage-resembles-known-model' (the set holds the certifier's own model, or for Class A a model of its family, without the
// token naming it whole).
function lineageRefusal(value, ownModel, ownFamily) {
  if (!lineageTokenInGrammar(value)) return 'lineage-token-outside-grammar';
  const held = lineageHeldModels(value);
  if (!(held.includes(ownModel) || (ownFamily !== 'UNKNOWN' && held.some(model => canonicalFamily(model) === ownFamily)))) return null;
  const plain = lineagePlainModel(value);
  if (plain === 'UNKNOWN') return 'unknown-lineage-resembles-known-model';
  return plain === ownModel ? 'non-independent-seat' : null;
}
// An explicit family declaration: a maker label exactly as the closed rules spell it, or any spelling of a model of that maker.
// Nothing else is a family.
function declaredFamily(value) {
  if (typeof value !== 'string' || value.length > MAX_SPELLING) return 'UNKNOWN';
  if (FAMILY_LABELS.has(value)) return dash(value);
  return lineageFamily(value);
}
module.exports = { canonicalModel, lineageModel, canonicalFamily, lineageFamily, lineageHeldModels, lineageTokenInGrammar, lineagePlainModel, lineageRefusal, declaredFamily, dash };
