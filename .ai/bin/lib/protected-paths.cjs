'use strict';
// protected-paths: the ONE place that decides whether a path names something the host keeps off limits.
// Two kinds of refusal live here:
//   - a network share or a Windows device path (a leading pair of separators: UNC, \\?\ and \\.\ prefixes);
//   - a name from the host-owned list of protected names (a share or folder the host owner declared read only).
// The list is never part of the shipped code. The host supplies it, and the tools only read it:
//   1. the environment variable PROTOCOL_PROTECTED_NAMES: names separated by comma, semicolon or a new line;
//   2. the optional file .ai/protected-names.json in the project that holds this file: { "names": ["name", ...] }.
// Both sources are added together. A host that declares nothing protects no name (the list is empty);
// a network or device path is refused either way. A declared name is matched without regard to case.
// A file that exists but cannot be read or does not have the shape above is an error, never an empty list:
// a damaged declaration must not silently switch a guard off.
const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('./text-safe.cjs');

const ENV_NAMES = 'PROTOCOL_PROTECTED_NAMES';
const CONFIG_REL = '.ai/protected-names.json';
const MAX_NAMES = 64;
const MAX_NAME = 128;
const MAX_BYTES = 65536;
const DEFAULT_ROOT = path.resolve(__dirname, '..', '..', '..');
const MODES = Object.freeze(['any', 'segment', 'word']);
const fileCache = new Map();

const fail = detail => { throw Object.assign(new Error(`PROTECTED-PATHS-CONFIG ${detail}`), { code: 'PROTECTED-PATHS-CONFIG' }); };
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function cleanName(value, where) {
  if (typeof value !== 'string') fail(`${where}: a name must be a string`);
  const name = value.trim();
  if (!name || name.length > MAX_NAME || /[\x00-\x1f\x7f/\\]/.test(name)) fail(`${where}: a name is one short token without separators or control characters`);
  return name.toLowerCase();
}

// The names of one host config text (the content of .ai/protected-names.json), for callers that read it from elsewhere.
function namesFromConfigText(text) {
  let doc;
  // The shared unique-key reader: a repeated key is a damaged declaration, not a quiet last-value-wins.
  try { doc = textSafe.parseJsonUnique(String(text).charCodeAt(0) === 0xFEFF ? String(text).slice(1) : String(text)); } catch (e) { return fail(`${CONFIG_REL}: ${e && e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice' : 'not valid JSON'}`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Array.isArray(doc.names)) fail(`${CONFIG_REL}: an object with a names array is required`);
  return doc.names.map(n => cleanName(n, CONFIG_REL));
}

function namesFromEnv(env) {
  const raw = env && env[ENV_NAMES];
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw !== 'string') fail(`${ENV_NAMES} must be a string`);
  return raw.split(/[,;\r\n]+/).map(s => s.trim()).filter(Boolean).map(s => cleanName(s, ENV_NAMES));
}

function fromFile(root) {
  const file = path.join(root, CONFIG_REL);
  let st;
  try { st = fs.statSync(file); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    return fail(`${CONFIG_REL}: ${e && e.code || 'unreadable'}`);
  }
  if (!st.isFile() || st.size > MAX_BYTES) fail(`${CONFIG_REL}: a regular file of at most ${MAX_BYTES} bytes is required`);
  const key = `${file}\u0000${st.mtimeMs}\u0000${st.size}`;
  if (fileCache.has(key)) return fileCache.get(key);
  const names = namesFromConfigText(fs.readFileSync(file, 'utf8'));
  fileCache.clear();
  fileCache.set(key, names);
  return names;
}

// The protected names of this host: lower case, no duplicates. opts.env and opts.root exist for tests and for callers
// that already hold a validated environment; the default is the process environment and the project of this file.
function protectedNames(opts = {}) {
  const env = opts.env || process.env;
  const root = opts.root || DEFAULT_ROOT;
  const all = [...new Set([...namesFromEnv(env), ...fromFile(root)])];
  if (all.length > MAX_NAMES) fail(`at most ${MAX_NAMES} protected names`);
  return all;
}

// A leading pair of separators is a network share or a device namespace on Windows (and a double slash elsewhere).
function isNetworkOrDevicePath(value) {
  return typeof value === 'string' && /^[\\/]{2}/.test(value);
}

// mode "any": the name appears anywhere in the text; "segment": it is a whole path component; "word": it is bounded
// by anything that is not a letter, a digit or an underscore. Each site keeps the strictness it had before.
function hasProtectedName(value, opts = {}) {
  if (typeof value !== 'string') return false;
  const mode = opts.mode === undefined ? 'any' : opts.mode;
  if (!MODES.includes(mode)) throw new TypeError(`protected-paths: unknown mode ${String(mode)}`);
  const names = opts.names || protectedNames(opts);
  if (!names.length) return false;
  const low = value.toLowerCase();
  return names.some(name => {
    if (mode === 'any') return low.includes(name);
    const re = mode === 'segment'
      ? new RegExp(`(?:^|[\\\\/])${escape(name)}(?:[\\\\/]|$)`)
      : new RegExp(`(?<![A-Za-z0-9_])${escape(name)}(?![A-Za-z0-9_])`);
    return re.test(low);
  });
}

// True when the value must be refused: a network or device path (unless opts.network is false) or a protected name.
function isProtectedPath(value, opts = {}) {
  if (typeof value !== 'string') return false;
  if (opts.network !== false && isNetworkOrDevicePath(value)) return true;
  return hasProtectedName(value, opts);
}

module.exports = { ENV_NAMES, CONFIG_REL, protectedNames, namesFromEnv, namesFromConfigText, isNetworkOrDevicePath, hasProtectedName, isProtectedPath };
