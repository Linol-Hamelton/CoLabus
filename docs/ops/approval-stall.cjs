'use strict';
// APPROVAL_STALL (AUTO-APPROVE): a seat that stopped on a permission prompt ends with its own failure class, found from
// the client output, never as a silent idle or a plain NO_VERDICT. The launchers (cert-launch.cjs, fix-launch.cjs, tools/operator/run-client.cjs)
// call approvalStall on the decoded output of a launch that FAILED (non-zero or no exit status, or no verdict); a run that ended cleanly is never
// reclassified. The patterns are the client's autoApprove.stall list in .ai/docs/clients.json plus the generic list below. None of them was
// measured from a real client (no real prompt text was captured): they are fixture patterns, marked so in the registry.
// The evidence names a pattern id only; no text of the client output leaves this module (run-client keeps raw output private).
const path = require('node:path');

// Generic prompt shapes of any client (fixture-derived, case-insensitive, one line each).
const GENERIC = [
  { id: 'generic-yes-no', regex: '\\?\\s*(?:\\[[yY](?:es)?/[nN]o?\\]|\\([yY](?:es)?/[nN]o?\\))\\s*$' },
  { id: 'generic-waiting-approval', regex: '\\b(?:waiting|awaiting) (?:for )?(?:the |user |your )?(?:approval|permission|confirmation)\\b' },
  { id: 'generic-approval-required', regex: '\\b(?:approval|permission) (?:is )?required\\b' },
];
// Only the ending of the output is read: a stalled client prints its prompt last, so a prompt-like line counts only among the last ENDING_LINES
// non-blank lines; a prompt mid-output followed by more lines is an earlier step of a run that went on.
const ENDING_LINES = 3;
const LINE_MAX = 2000;

function compile(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (!p || typeof p.id !== 'string' || typeof p.regex !== 'string' || !/^[a-z0-9-]{1,60}$/.test(p.id)) continue;
    try { out.push({ id: p.id, re: new RegExp(p.regex, 'i') }); } catch { /* a broken registry pattern is skipped, never thrown */ }
  }
  return out;
}

function registryPatterns(client, registry) {
  try {
    const reg = registry || require('../../.ai/bin/protocol-dispatch/registry.cjs').loadRegistry(path.resolve(__dirname, '..', '..', '.ai', 'docs', 'clients.json'));
    const c = reg && reg.clients && Object.hasOwn(reg.clients, client) ? reg.clients[client] : null;
    return compile(c && c.autoApprove && c.autoApprove.stall);
  } catch { return []; }
}

function patternsFor(client, registry) {
  return [...registryPatterns(client, registry), ...compile(GENERIC)];
}

// { id } of the first pattern that matches one of the ending lines of a text, or null. failed=false always gives null. texts: several streams
// of one run (stdout, stderr), each judged by its own ending, so text one stream printed later never hides the prompt that ends the other.
function approvalStall({ client, text, texts, failed, registry }) {
  if (!failed) return null;
  const all = (Array.isArray(texts) ? texts : [text]).filter(s => typeof s === 'string' && s);
  if (!all.length) return null;
  const pats = patternsFor(client, registry);
  for (const s of all) {
    const lines = s.split(/\r?\n/).filter(l => l.trim()).slice(-ENDING_LINES).map(l => l.slice(0, LINE_MAX));
    for (let i = lines.length - 1; i >= 0; i--) {
      for (const p of pats) if (p.re.test(lines[i])) return { id: p.id };
    }
  }
  return null;
}

// The seat runner of the operator layer (tools/operator/run-client.cjs) holds the streams as bytes: each is decoded by the shared strict decoder
// (.ai/bin/lib/text-safe.cjs); a stream it refuses gives no evidence. The decoded text is read here only and never returned.
function fromStreams({ client, stdout, stderr, failed, registry }) {
  if (!failed) return null;
  const { decode } = require('../../.ai/bin/lib/text-safe.cjs');
  const texts = [stdout, stderr].map(b => (b instanceof Uint8Array ? decode(b) : null)).filter(d => d && d.ok).map(d => d.text);
  return approvalStall({ client, texts, failed, registry });
}

const safeClient = c => String(c || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unknown';
const stallLine = (client, hit) => `APPROVAL_STALL client=${safeClient(client)} evidence=pattern:${hit.id}`;

module.exports = { GENERIC, ENDING_LINES, approvalStall, fromStreams, patternsFor, stallLine };
