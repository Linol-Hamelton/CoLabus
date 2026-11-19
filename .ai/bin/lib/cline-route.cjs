'use strict';
// cline-route.cjs - the Cline CLI route (CLINE-ROUTE). Pure: no file, no process, no environment is read.
// Measured on 2026-10-30 with cline 3.0.74 (tests/fixtures/cline/*.jsonl are real runs):
//   cline --json --auto-approve true -P PROVIDER -m MODEL -c WORKTREE -t SECONDS [--thinking none|low|medium|high|xhigh] "PROMPT"
//   stdin must be closed (the client waits for input otherwise); --json prints one JSON event per line;
//   the event of type run_result carries finishReason, usage {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCost},
//   text and model {id, provider}. model.id is the model the launcher asked for (launcher-model proof), not a provider banner.
//   A provider the client does not know ends with finishReason "error" and the text 'Unknown or disabled provider "NAME".' (exit 1).
// Owner rule: Cline runs with its own settings. This module never builds --config, --data-dir or -k and names no key or settings file.
const THINKING = Object.freeze(['none', 'low', 'medium', 'high', 'xhigh']);
const FORBIDDEN_FLAGS = Object.freeze(['--config', '--data-dir', '-k']);
const SUBSCRIPTION = 'openai-compatible';
const FREE = 'cline';

// The closed table of the models enabled for this route. identity is the model for the independence rules: an effort or tier spelling
// of one model is that model (as gemini-3.8-flash-high is gemini-3.8-flash in the alias data); server-sonnet-5.5 is read as Sonnet 5.5, the
// conservative reading for independence (open item of the author report). family is the maker. A free model is advisory only (level 0).
const row = (provider, identity, family, tier) => Object.freeze({ provider, identity, family, tier });
const sub = (identity, family) => row(SUBSCRIPTION, identity, family, 'subscription');
const free = (identity, family) => row(FREE, identity, family, 'free');
const MODELS = Object.freeze(Object.assign(Object.create(null), {
  'claude-sonnet-5-5': sub('claude-sonnet-5-5', 'anthropic'),
  'claude-sonnet-5-5-low': sub('claude-sonnet-5-5', 'anthropic'),
  'claude-sonnet-5-5-medium': sub('claude-sonnet-5-5', 'anthropic'),
  'claude-sonnet-5-5-high': sub('claude-sonnet-5-5', 'anthropic'),
  'server-sonnet-5.5': sub('claude-sonnet-5-5', 'anthropic'),
  'claude-opus-5-5': sub('claude-opus-5-5', 'anthropic'),
  'claude-opus-5-5-low': sub('claude-opus-5-5', 'anthropic'),
  'claude-opus-5-5-medium': sub('claude-opus-5-5', 'anthropic'),
  'claude-opus-5-5-high': sub('claude-opus-5-5', 'anthropic'),
  'gemini-2.5-flash': sub('gemini-2.5-flash', 'google'),
  'gemini-2.5-flash-lite': sub('gemini-2.5-flash-lite', 'google'),
  'gemini-2.5-flash-thinking': sub('gemini-2.5-flash', 'google'),
  'gemini-3-flash': sub('gemini-3-flash', 'google'),
  'gemini-3.1-flash-image': sub('gemini-3.1-flash-image', 'google'),
  'gemini-3.8-flash': sub('gemini-3.8-flash', 'google'),
  'gemini-3.8-flash-low': sub('gemini-3.8-flash', 'google'),
  'gemini-3.8-flash-medium': sub('gemini-3.8-flash', 'google'),
  'gemini-3.8-flash-high': sub('gemini-3.8-flash', 'google'),
  'gemini-3.8-flash-tiered': sub('gemini-3.8-flash', 'google'),
  'gemini-4-argon': sub('gemini-4-argon', 'google'),
  'gemini-4-argon-low': sub('gemini-4-argon', 'google'),
  'gemini-4-argon-medium': sub('gemini-4-argon', 'google'),
  'gemini-4-argon-high': sub('gemini-4-argon', 'google'),
  'gpt-oss-120b-medium': sub('gpt-oss-120b', 'openai'),
  'gpt-6.1-sol': sub('gpt-6.1-sol', 'openai'),
  'gpt-6': sub('gpt-6', 'openai'),
  'gpt-6-sol': sub('gpt-6-sol', 'openai'),
  'gpt-6-astra': sub('gpt-6-astra', 'openai'),
  'gpt-6-luna': sub('gpt-6-luna', 'openai'),
  'gpt-6.1-terra': sub('gpt-6.1-terra', 'openai'),
  'reflection/beam-free': free('reflection/beam-free', 'reflection'),
  'cline-free/nemotron-3.5-super-vl': free('cline-free/nemotron-3.5-super-vl', 'nvidia'),
  'nvidia/nemotron-3.5-lightning-free': free('nvidia/nemotron-3.5-lightning-free', 'nvidia'),
  'poolside/laguna-s-2.1-free': free('poolside/laguna-s-2.1-free', 'poolside'),
  'cline-free/solar-mini4': free('cline-free/solar-mini4', 'upstage'),
}));
// The model one probe sends its short prompt to, per provider: the lite tier of the subscription provider and the mini model of the free one.
const PROBE_MODELS = Object.freeze({ [SUBSCRIPTION]: 'gemini-2.5-flash-lite', [FREE]: 'cline-free/solar-mini4' });

const describe = model => (typeof model === 'string' && Object.hasOwn(MODELS, model) ? MODELS[model] : null);
const identityOf = model => (describe(model) || {}).identity || 'UNKNOWN';
const familyOf = model => (describe(model) || {}).family || 'UNKNOWN';
const providerOf = model => (describe(model) || {}).provider || null;

// The MiMo lease (one MiMo seat at a time, tools/assign/policy.json singleSeat): cline serves many models, so only a model outside the table (the old
// cline-free/mimo-v2.6-flash route among them) or one that names MiMo holds it.
const holdsMimoLease = model => !describe(model) || /mimo/i.test(model);

// A free model is advisory only (level 0): never a certifier and never a sealed seat (the seat check refuses it as a non-independent seat).
const advisoryOnly = model => (describe(model) || {}).tier === 'free';

// The argv after the executable: the one invocation of every launch path. Throws a named Error; never builds a forbidden flag.
function launchArgs({ model, worktree, prompt, thinking, timeoutS = 3300 }) {
  const entry = describe(model);
  if (!entry) throw new Error('cline-model-unknown');
  if (typeof worktree !== 'string' || !worktree || worktree.startsWith('-')) throw new Error('invalid-worktree');
  if (typeof prompt !== 'string' || !prompt.trim() || /[\r\n]/.test(prompt) || prompt.startsWith('-')) throw new Error('invalid-prompt');
  if (!Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > 86400) throw new Error('invalid-timeout');
  if (thinking !== undefined && !THINKING.includes(thinking)) throw new Error('invalid-effort');
  return ['--json', '--auto-approve', 'true', '-P', entry.provider, '-m', model, '-c', worktree, '-t', String(timeoutS),
    ...(thinking === undefined ? [] : ['--thinking', thinking]), prompt];
}
// The probe argv: one short prompt on the requested route model (the caller picks the directory and timeout).
function probeArgs({ model, question, timeoutS = 120 }) {
  const entry = describe(model);
  if (!entry) return null;
  return ['--json', '--auto-approve', 'true', '-P', entry.provider, '-m', model, '-t', String(timeoutS), question];
}
// stdin is closed for every Cline start: the client waits for input otherwise.
const STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

// True when one object of a JSON text names the same key twice (JSON.parse keeps the last value, so two sources of one field would read as one).
// Only valid JSON is given: strings are skipped whole, a stack holds the keys seen in each open object.
function repeatsKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',') { const top = stack[stack.length - 1]; if (top) top.expectKey = true; }
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return true;
        top.keys.add(key); top.expectKey = false;
      }
      i = j;
    }
  }
  return false;
}
// The run_result event of a captured output. Exactly one is the run; none, several or an unreadable one is named, never guessed.
function parseRun(text) {
  let found = null, count = 0, broken = false, repeated = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line[0] !== '{' || !line.includes('"run_result"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { broken = true; continue; }
    if (event && typeof event === 'object' && event.type === 'run_result') { found = event; count += 1; if (repeatsKey(line)) repeated = true; }
  }
  if (broken) return { run: null, reason: 'a run_result line is not readable JSON (truncated or corrupted)' };
  if (repeated) return { run: null, reason: 'a run_result line names a key twice (two sources of one field)' };
  if (count === 0) return { run: null, reason: 'no run_result event in the Cline output' };
  if (count > 1) return { run: null, reason: 'several run_result events in the Cline output' };
  return { run: found, reason: null };
}

const nat = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const SPLIT = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
// The counts of one run: a counter the client did not print is null (never 0); a printed value that is not a count makes the whole usage unknown.
function usageOf(text) {
  const { run, reason } = parseRun(text);
  const none = why => ({ counts: null, costUsd: null, reason: why, run });
  if (!run) return none(reason);
  const u = run.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return none('run_result carries no usage');
  const a = run.aggregateUsage;
  if (a !== undefined && a !== null && (typeof a !== 'object' || SPLIT.some(k => a[k] !== u[k]))) return none('usage and aggregateUsage of the run_result differ; the usage of the run is unknown');
  const counts = {};
  for (const k of SPLIT) {
    if (u[k] === undefined || u[k] === null) { counts[k] = null; continue; }
    if (nat(u[k]) === null) return none(`usage.${k} is not a non-negative integer`);
    counts[k] = u[k];
  }
  if (counts.inputTokens === null || counts.outputTokens === null) return none('usage carries no inputTokens or outputTokens');
  const cost = typeof u.totalCost === 'number' && Number.isFinite(u.totalCost) && u.totalCost >= 0 ? u.totalCost : null;
  return { counts: { input: counts.inputTokens, output: counts.outputTokens, cacheRead: counts.cacheReadTokens, cacheWrite: counts.cacheWriteTokens }, costUsd: cost, reason: null, run };
}

// The served-model proof of a finished run: the model the launcher asked for, echoed by run_result, on the provider of the closed table.
// Only a completed run proves; match is false when the echo is another model. Anything else is no proof (null).
function proofOf(text, requested) {
  const { run } = parseRun(text);
  const entry = describe(requested);
  if (!run || !entry || run.finishReason !== 'completed') return null;
  const m = run.model;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.provider !== entry.provider) return null;
  return { match: m.id === requested, source: 'launcher-model', servedModel: m.id };
}

// The probe reading of an output: ok only for a completed run whose whole answer is OK. A provider the client refuses is named from its own
// error text; any other failure leaves the reason to the generic classes of the probe (null).
function probeVerdict(text) {
  const { run } = parseRun(text);
  if (!run) return { ok: false, reason: null };
  const answer = typeof run.text === 'string' ? run.text : '';
  if (run.finishReason === 'completed' && answer.trim() === 'OK') return { ok: true, reason: null };
  if (/Unknown or disabled provider/i.test(answer)) return { ok: false, reason: 'PROVIDER_UNAVAILABLE' };
  if (run.finishReason === 'completed') return { ok: false, reason: 'NO_ANSWER' };
  return { ok: false, reason: null };
}

module.exports = { THINKING, FORBIDDEN_FLAGS, MODELS, PROBE_MODELS, STDIO, SUBSCRIPTION, FREE, describe, identityOf, familyOf, providerOf, holdsMimoLease, advisoryOnly, launchArgs, probeArgs, parseRun, usageOf, proofOf, probeVerdict };
