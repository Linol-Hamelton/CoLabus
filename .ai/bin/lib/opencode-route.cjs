'use strict';
// opencode-route.cjs - the opencode CLI route for MiniMax. Pure: no file, no process, no environment is read.
// Measured on 2026-11-14 with opencode 1.19.5 against the configuration the owner keeps (never an isolated one; provider minimax through the
// openai-compatible SDK); the source repository keeps the filtered real events of these runs as its test fixture:
//   opencode run --auto --format json --dir WORKTREE --model minimax/MiniMax-M3 "PROMPT"      stdin closed
//   --format json prints one JSON event per line: step_start, text, tool_use, step_finish (reason "stop" ends a run, "tool-calls" ends a step);
//   the step_finish part carries tokens {total, input, output, reasoning, cache {read, write}} and a client cost estimate. No event names the
//   model: the stream proves only the model the launcher asked for (--model). `opencode export SESSION` names it per message (providerID, modelID).
//   Without --auto a write or a shell command inside the worktree runs, and a write outside it is rejected as a tool error with exit 0;
//   with --auto the same outside write runs. A seat therefore always passes --auto and --dir, like the kilo seat.
// The closed table below is the one place a model of this client is approved; any other model of opencode has no approved command.
const row = (provider, identity, family, tier) => Object.freeze({ provider, identity, family, tier });
const MODELS = Object.freeze(Object.assign(Object.create(null), {
  'minimax/MiniMax-M3': row('minimax', 'MiniMax-M3', 'minimax', 'subscription'),
}));

const describe = model => (typeof model === 'string' && Object.hasOwn(MODELS, model) ? MODELS[model] : null);

// The argv after the executable: the one invocation of every launch path. Throws a named Error.
function launchArgs({ model, worktree, prompt }) {
  if (!describe(model)) throw new Error('opencode-model-unknown');
  if (typeof worktree !== 'string' || !worktree || worktree.startsWith('-')) throw new Error('invalid-worktree');
  if (typeof prompt !== 'string' || !prompt.trim() || /[\r\n]/.test(prompt) || prompt.startsWith('-')) throw new Error('invalid-prompt');
  return ['run', '--auto', '--format', 'json', '--dir', worktree, '--model', model, prompt];
}
// The probe argv: one short prompt on the requested route model; the caller picks the directory (the process cwd of the probe).
function probeArgs({ model, question }) {
  if (!describe(model) || typeof question !== 'string' || !question.trim() || /[\r\n]/.test(question) || question.startsWith('-')) return null;
  return ['run', '--format', 'json', '--model', model, question];
}
// stdin is closed for every opencode start.
const STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);
const SEAT_TIMEOUT_MS = 60 * 60 * 1000;

// Only client diagnostics and native tool-error envelopes can prove a permission
// rejection. Assistant text that quotes a diagnostic is not a client failure.
function failureOf(result, streams = {}) {
  if (result?.error?.code === 'ETIMEDOUT') return { failureClass: 'STALL', reason: 'seat-timeout' };
  const rejected = text => typeof text === 'string' && /external_directory/i.test(text)
    && /auto-reject(?:ing|ed)?|permission[^\n]*reject|reject[^\n]*permission/i.test(text);
  const stderr = typeof streams.stderr === 'string' ? streams.stderr : '';
  if (stderr.split(/\r?\n/).some(rejected)) return { failureClass: 'NO_VERDICT', reason: 'external-directory-rejected' };
  for (const raw of String(streams.stdout || '').split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(raw); } catch { continue; }
    if (e?.type === 'tool_use' && e.part?.state?.status === 'error') {
      if (rejected(e.part.state.error)) return { failureClass: 'NO_VERDICT', reason: 'external-directory-rejected' };
      // The native tool error does not always repeat the permission's name.
      if (typeof e.part.state.error === 'string' && /^The user rejected permission to use this specific tool call\.[\r\n ]*$/.test(e.part.state.error)) {
        return { failureClass: 'NO_VERDICT', reason: 'permission-rejected' };
      }
    }
  }
  return null;
}

// The events of a captured output. An unreadable event line is named, never guessed around.
function parseRun(text) {
  const events = [];
  let broken = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line[0] !== '{') continue;
    try { const e = JSON.parse(line); if (e && typeof e === 'object') events.push(e); else broken += 1; } catch { broken += 1; }
  }
  const finishes = events.filter(e => e.type === 'step_finish' && e.part && typeof e.part === 'object');
  const answers = events.filter(e => e.type === 'text' && e.part && typeof e.part.text === 'string');
  const finalAnswers = events.slice(events.findLastIndex(e => e.type === 'step_start') + 1)
    .filter(e => e.type === 'text' && typeof e.part?.text === 'string');
  return {
    broken,
    steps: finishes.length,
    finish: finishes.length ? finishes[finishes.length - 1].part.reason : null,
    // the model may print its reasoning as a think block inside a text event; it is never the answer
    text: answers.map(e => e.part.text).join('').replace(/<think>[\s\S]*?<\/think>/g, '').trim(),
    finalText: finalAnswers.length ? finalAnswers.at(-1).part.text.replace(/<think>[\s\S]*?<\/think>/g, '').trim() : null,
    failed: events.some(e => e.type === 'error'),
    sessionId: (events.find(e => typeof e.sessionID === 'string') || {}).sessionID || null,
  };
}

// Author markers belong to the final answer of a completed native run, never
// to JSON syntax, reasoning, an earlier tool step or a usage counter.
function completionText(text) {
  const run = parseRun(text);
  return !run.broken && !run.failed && run.steps > 0 && run.finish === 'stop' ? run.finalText : null;
}

// The served-model proof of a finished run: the model the launcher asked for, on a run that ended with finish reason stop and no error event.
// The stream names no model, so the source is the launcher flag; anything else is no proof (null).
function proofOf(text, requested) {
  const run = parseRun(text);
  if (!describe(requested) || run.broken || run.failed || run.steps < 1 || run.finish !== 'stop') return null;
  return { match: true, source: 'launcher-model', servedModel: requested };
}

// The probe reading of an output: ok only for a finished run whose whole answer is OK.
function probeVerdict(text) {
  const run = parseRun(text);
  if (run.broken || run.failed || run.steps < 1) return { ok: false, reason: null };
  if (run.finish === 'stop' && run.text.trim() === 'OK') return { ok: true, reason: null };
  return { ok: false, reason: run.finish === 'stop' ? 'NO_ANSWER' : null };
}

module.exports = { MODELS, describe, launchArgs, probeArgs, STDIO, SEAT_TIMEOUT_MS, failureOf, parseRun, completionText, proofOf, probeVerdict };
