'use strict';
// Read-only projection. Never return raw settings, endpoints or credential values.
const path = require('node:path');
const { readPublicJson, MAX_BYTES } = require('./public-json.cjs');
const { safeIdentifier } = require('./metadata.cjs');
const { isProtectedPath } = require('../lib/protected-paths.cjs');
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const present = x => typeof x === 'string' && x.trim().length > 0;
function safeName(value) {
  try { safeIdentifier(value); return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value); } catch { return false; }
}
// Remove comments and trailing commas only outside JSON strings; duplicate keys
// and malformed UTF-8 are still rejected by the shared strict reader.
function jsonc(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_BYTES) throw Error('CONFIG_INVALID');
  if (text.charCodeAt(0) === 0xfeff) throw Error('CONFIG_BOM_REFUSED');
  let clean = '', quote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (quote) { clean += c; if (c === '\\') clean += text[++i] || ''; else if (c === '"') quote = false; }
    else if (c === '"') { quote = true; clean += c; }
    else if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; clean += '\n'; }
    else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2); if (end < 0) throw Error('CONFIG_INVALID'); i = end + 1; clean += ' ';
    } else clean += c;
  }
  let normalized = ''; quote = false;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote) { normalized += c; if (c === '\\') normalized += clean[++i] || ''; else if (c === '"') quote = false; }
    else if (c === '"') { quote = true; normalized += c; }
    else if (c !== ',' || !/^\s*[}\]]/.test(clean.slice(i + 1))) normalized += c;
  }
  return readPublicJson(Buffer.from(normalized));
}
function discover({ home, root, projectRoot = root, read, file, env = {}, now, publicInput }) {
  const providers = new Map(), models = new Map(), missing = [], credentials = new Set(), keyOverrides = new Set();
  const remember = value => { if (present(value) && !/^\{(?:env|file):/.test(value)) credentials.add(value); };
  const rememberCredentials = data => {
    if (!data || typeof data !== 'object') return;
    for (const [key, value] of Object.entries(data)) {
      if (key.toLowerCase() === 'headers' && object(value)) Object.values(value).forEach(remember);
      else if (/key|token|secret|password|access|refresh/i.test(key) && present(value)) remember(value);
      else if (value && typeof value === 'object') rememberCredentials(value);
    }
  };
  const miss = (id, reason) => missing.push({ id, reason, action: 'Owner: check Kilo configuration or declare public metadata' });
  const provider = id => {
    if (!safeName(id) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id)) { miss('kilo-provider', 'CONFIG_NAME_UNSAFE'); return null; }
    const name = id.toLowerCase();
    if (!providers.has(name)) providers.set(name, { name, keyPresent: false });
    return providers.get(name);
  };
  const hasKey = (value, location) => {
    if (!present(value)) return false;
    const ref = /^\{env:([A-Za-z_][A-Za-z0-9_]{0,79})\}$/.exec(value);
    if (ref) { remember(env[ref[1]]); return present(env[ref[1]]); }
    const fileRef = /^\{file:([^{}\r\n]+)\}$/.exec(value);
    if (fileRef) {
      const name = fileRef[1].startsWith('~/') ? path.join(home, fileRef[1].slice(2)) : path.resolve(path.dirname(location), fileRef[1]);
      // Check presence only; never open a referenced credential file.
      if (isProtectedPath(name)) return false;
      try { return file(name) === true; } catch { return false; }
    }
    return !/^\{(?:env|file):/.test(value);
  };
  const locations = [{ id: 'kilo-auth', file: path.join(home, '.local/share/kilo/auth.json'), auth: true }];
  const dirs = [{ dir: path.join(home, '.config/kilo'), scope: 'user' }];
  let dir = path.resolve(projectRoot);
  for (let depth = 0; depth < 32; depth++) {
    // Ancestors first, nearest project last, matching the configuration overlay.
    dirs.splice(1, 0, ...['', '.kilo', '.kilocode'].map(sub => ({ dir: path.join(dir, sub), scope: 'project' })));
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  for (const d of dirs) for (const stem of ['config', 'opencode', 'kilo']) for (const ext of ['json', 'jsonc']) {
    locations.push({ id: `kilo-${d.scope}-${stem}-${ext}`, file: path.join(d.dir, `${stem}.${ext}`), auth: false });
  }
  let seen = false;
  for (const location of locations) {
    let exists;
    try { exists = file(location.file); } catch { seen = true; miss(location.id, 'CONFIG_UNREADABLE'); continue; }
    if (!exists) continue;
    seen = true;
    let data;
    try { data = jsonc(read(location.file)); } catch (e) { miss(location.id, e.message === 'CONFIG_BOM_REFUSED' ? 'CONFIG_BOM_REFUSED' : 'CONFIG_UNREADABLE_OR_INVALID'); continue; }
    if (!object(data)) { miss(location.id, 'CONFIG_FORMAT_UNKNOWN'); continue; }
    if (location.auth) {
      for (const [id, auth] of Object.entries(data)) {
        const p = provider(id); if (!p) continue;
        if (!object(auth) || !['api', 'oauth'].includes(auth.type)) { miss(p.name, 'AUTH_FORMAT_UNKNOWN'); continue; }
        rememberCredentials(auth);
        p.keyPresent = p.keyPresent || (auth.type === 'api' ? hasKey(auth.key, location.file) : hasKey(auth.access, location.file));
      }
      continue;
    }
    if (data.provider !== undefined && !object(data.provider)) { miss(location.id, 'CONFIG_FORMAT_UNKNOWN'); continue; }
    if (!data.provider && !['$schema', 'model', 'mcp', 'instructions', 'skills', 'agent', 'theme'].some(k => Object.hasOwn(data, k))) {
      miss(location.id, 'CONFIG_FORMAT_UNKNOWN'); continue;
    }
    for (const [id, config] of Object.entries(data.provider || {})) {
      // Only recognised provider entries contribute secret candidates. Generic
      // JSON files in an ancestor must not poison unrelated public identifiers.
      if (object(config)) rememberCredentials(config);
      const p = provider(id); if (!p) continue;
      if (!object(config)) { miss(p.name, 'PROVIDER_FORMAT_UNKNOWN'); continue; }
      const envNames = Array.isArray(config.env) ? config.env.filter(n => typeof n === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(n)) : [];
      for (const n of envNames) remember(env[n]);
      // Explicit nearest key/env entries override earlier user/ancestor values;
      // a model-only overlay keeps the inherited authentication fact.
      if (Object.hasOwn(config.options || {}, 'apiKey') || Object.hasOwn(config, 'env')) {
        keyOverrides.add(p.name);
        p.keyPresent = hasKey(config.options?.apiKey, location.file) || envNames.some(n => present(env[n]));
      }
      if (config.models !== undefined && !object(config.models)) { miss(p.name, 'MODEL_METADATA_UNKNOWN'); continue; }
      for (const [id, model] of Object.entries(config.models || {})) {
        if (!safeName(id)) { miss(p.name, 'CONFIG_NAME_UNSAFE'); continue; }
        const modalities = x => Array.isArray(x) ? [...new Set(x.filter(v => ['text', 'image', 'video', 'audio', 'embedding'].includes(v)))] : [];
        const input = modalities(model?.modalities?.input), output = modalities(model?.modalities?.output);
        const routeId = id.startsWith(p.name + '/') ? id : `${p.name}/${id}`;
        if (!safeName(routeId)) { miss(p.name, 'CONFIG_NAME_UNSAFE'); continue; }
        models.set(`${p.name}\0${routeId}`, { providerRef: p.name, id: routeId, inputModalities: input, outputModalities: output,
          operations: output.some(v => ['image', 'video'].includes(v)) ? ['generate'] : ['unknown'],
          paid: model?.cost && (model.cost.input > 0 || model.cost.output > 0) ? true : 'unknown' });
      }
    }
  }
  for (const [id, names] of Object.entries({ deepseek: ['DEEPSEEK_API_KEY'], nvidia: ['NVIDIA_API_KEY'],
    'cloudflare-ai-gateway': ['CLOUDFLARE_AI_GATEWAY_API_KEY', 'CLOUDFLARE_API_TOKEN'] })) {
    for (const name of names) if (present(env[name])) {
      remember(env[name]);
      if (!keyOverrides.has(id)) provider(id).keyPresent = true;
    }
  }
  if (!seen) miss('kilo-config', 'CONFIG_NOT_FOUND');
  // Case-sensitive literal matching. Short secrets match whole fields only;
  // substring candidates need eight characters, avoiding common-letter poison.
  const contaminated = text => credentials.has(text) || [...credentials].some(value => value.length >= 8 && text.includes(value));
  for (const [key, p] of providers) if (contaminated(p.name)) { providers.delete(key); miss('kilo-provider', 'CONFIG_NAME_UNSAFE'); }
  for (const [key, model] of models) if (!providers.has(model.providerRef) || contaminated(model.id)) { models.delete(key); miss('kilo-model', 'CONFIG_NAME_UNSAFE'); }
  for (const row of missing) if (contaminated(row.id)) row.id = 'kilo-config';
  if (providers.size > 64 || models.size > 256) {
    providers.clear(); models.clear(); miss('kilo-config', 'CONFIG_LIMIT_EXCEEDED');
  }
  for (const p of providers.values()) {
    if (!p.keyPresent) miss(p.name, 'KEY_MISSING');
    if (![...models.values()].some(m => m.providerRef === p.name)) miss(p.name, 'MODEL_METADATA_UNKNOWN');
  }
  // A client listing may repeat a configured credential as a supposed model ID.
  // Signal refusal without letting the credential leave this adapter.
  const containsCredential = value => typeof value === 'string' ? contaminated(value) : value && typeof value === 'object' &&
    Object.entries(value).some(([key, item]) => contaminated(key) || containsCredential(item));
  const refused = publicInput !== undefined && Boolean(containsCredential(publicInput));
  return { metadata: { schema: 'access-metadata/1', client: 'kilo', provenance: 'observed',
    at: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(),
    models: [...models.values()], userProviders: [...providers.values()], connectorMcp: [] }, missing, refused };
}
module.exports = { jsonc, discover };
