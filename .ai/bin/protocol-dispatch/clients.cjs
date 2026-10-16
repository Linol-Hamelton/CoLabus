'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function buildClientCommand(clientCfg, route, tokens, attemptKind = 'fresh') {
  const parts = [];
  const expand = tok => {
    let s = tok;
    for (const [k, v] of Object.entries(tokens)) {
      if (v !== undefined && v !== null) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  };

  const cmdList = (attemptKind === 'resume' && clientCfg.resume && clientCfg.resume.command)
    ? clientCfg.resume.command
    : clientCfg.command;

  let messageExpanded = false;
  for (const item of cmdList) {
    if (typeof item === 'string') {
      if (item.includes('{message}')) messageExpanded = true;
      parts.push(expand(item));
    } else if (item && typeof item === 'object' && item.if) {
      if (route && route[item.if]) {
        for (const a of item.args || []) {
          if (a.includes('{message}')) messageExpanded = true;
          parts.push(expand(a));
        }
      }
    }
  }

  if (attemptKind === 'resume' && !messageExpanded && tokens.message) {
    parts.push(tokens.message);
  }

  return parts;
}

// P-L3-005 (R-L3-005.1, .3, .6, .7): the effort flags of a launch come from the client registry, never from the launcher.
// flag/config with a value list: the value must be in effort.values (else ok=false: it is never requested) and the args are the
// registry's own {if: "effort"} template item; config without a value list (set in the client configuration), model-id (the
// effort is part of the model id), none and unknown: no flag, effortUsed null. An unregistered client gets no flag either.
function effortArgs(clientName, effort, registry) {
  const cfg = registry && registry.clients ? registry.clients[clientName] : null;
  if (!cfg) return { ok: true, args: [], effortUsed: null, how: 'unregistered', note: `client ${clientName} is not in the registry` };
  const e = cfg.effort || {};
  const how = e.how || 'unknown';
  if (!effort) return { ok: true, args: [], effortUsed: null, how, note: 'no effort requested' };
  if (how === 'flag' || how === 'config') {
    if (!Array.isArray(e.values)) return { ok: true, args: [], effortUsed: null, how, note: e.note || 'the registry lists no effort values for this client' };
    if (!e.values.includes(effort)) return { ok: false, args: [], effortUsed: null, how, error: `effort ${effort} is not in ${clientName}.effort.values (${e.values.join(', ')})` };
    const item = Array.isArray(cfg.command) ? cfg.command.find(i => i && typeof i === 'object' && i.if === 'effort') : null;
    if (!item || !Array.isArray(item.args)) return { ok: true, args: [], effortUsed: null, how, note: 'the command template has no effort item' };
    return { ok: true, args: item.args.map(a => String(a).replaceAll('{effort}', effort)), effortUsed: effort, how };
  }
  return { ok: true, args: [], effortUsed: null, how, note: e.note || `effort.how is ${how}: no flag` };
}

function formatCommandLine(tokens) {
  return tokens.map(t => {
    if (/[\s"]/.test(t)) {
      return `"${t.replace(/"/g, '\\"')}"`;
    }
    return t;
  }).join(' ');
}

function probeClient(clientName, registry, options = {}) {
  const clientCfg = registry.clients[clientName];
  if (!clientCfg) return { ok: false, state: 'UNKNOWN_CLIENT', rows: [`PROBE client=${clientName} state=UNKNOWN_CLIENT`] };
  const rows = [];
  let verOutput = null;
  try {
    const raw = execFileSync(clientCfg.binary, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true });
    verOutput = String(raw || '').trim().split(/\r?\n/)[0].trim();
  } catch {
    rows.push(`PROBE client=${clientName} state=ABSENT`);
    return { ok: false, state: 'ABSENT', rows };
  }
  if (clientCfg.version && verOutput !== clientCfg.version) {
    rows.push(`PROBE client=${clientName} state=VERSION_CHANGED expected="${clientCfg.version}" actual="${verOutput}"`);
    return { ok: false, state: 'VERSION_CHANGED', rows };
  }
  rows.push(`PROBE client=${clientName} state=OK version="${verOutput}"`);

  if (options.model && clientCfg.model && clientCfg.model.listing) {
    try {
      const listCmd = clientCfg.model.listing[0];
      const listArgs = clientCfg.model.listing.slice(1);
      const listOut = execFileSync(listCmd, listArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: true });
      if (listOut.includes(options.model)) {
        rows.push(`PROBE client=${clientName} model=${options.model} state=OK`);
      } else {
        rows.push(`PROBE client=${clientName} model=${options.model} state=MODEL_UNAVAILABLE`);
        return { ok: false, state: 'MODEL_UNAVAILABLE', rows };
      }
    } catch (e) {
      rows.push(`PROBE client=${clientName} model=${options.model} state=MODEL_UNAVAILABLE error="${e.message}"`);
      return { ok: false, state: 'MODEL_UNAVAILABLE', rows };
    }
  }
  return { ok: true, state: 'OK', rows };
}

function probeAll(registry, options = {}, clientFilter = []) {
  const clients = clientFilter.length ? clientFilter : Object.keys(registry.clients);
  let allOk = true;
  const rows = [];
  for (const c of clients) {
    const res = probeClient(c, registry, options);
    if (!res.ok) allOk = false;
    rows.push(...res.rows);
  }
  return { ok: allOk, rows };
}

function parseCodexTokenNumber(str) {
  if (!str) return NaN;
  const trimmed = str.trim();
  const mSuffix = trimmed.match(/([kKmM])$/);
  const suffix = mSuffix ? mSuffix[1].toUpperCase() : null;
  const numPart = suffix ? trimmed.slice(0, -1).trim() : trimmed;

  if (suffix) {
    const mult = suffix === 'K' ? 1000 : 1000000;
    const decMatch = numPart.match(/^([0-9\u00A0 ,.]*?)[.,]([0-9]{1,2})$/);
    if (decMatch) {
      const intPart = decMatch[1].replace(/[\u00A0 ,.]/g, '');
      const val = parseFloat((intPart || '0') + '.' + decMatch[2]);
      return Math.round(val * mult);
    }
    const cleaned = numPart.replace(/[\u00A0 ,.]/g, '');
    const val = parseInt(cleaned, 10);
    return isNaN(val) ? NaN : Math.round(val * mult);
  }

  const cleaned = numPart.replace(/[\u00A0 ,.]/g, '');
  return parseInt(cleaned, 10);
}

function parseUsageFromLog(logPath, usageParser) {
  const result = {
    tokens: { in: null, out: null, source: 'none' },
    usage: { amount: null, unit: null },
    found: false,
    rawUsage: null
  };

  if (!usageParser || usageParser === 'none' || !logPath || !fs.existsSync(logPath)) {
    return result;
  }

  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return result;
  }

  if (!text) {
    return result;
  }

  if (usageParser === 'kilo-json') {
    let costSum = 0;
    let inTokens = 0;
    let outTokens = 0;
    let stepCount = 0;
    let hasCost = false;
    let hasTokens = false;
    const rawMatches = [];

    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        const part = (parsed && parsed.part) ? parsed.part : parsed;
        if (part && part.type === 'step-finish') {
          stepCount++;
          rawMatches.push(line.trim());
          if (typeof part.cost === 'number' && !isNaN(part.cost)) {
            costSum += part.cost;
            hasCost = true;
          }
          if (part.tokens && typeof part.tokens === 'object') {
            if (typeof part.tokens.input === 'number' && !isNaN(part.tokens.input)) {
              inTokens += part.tokens.input;
              hasTokens = true;
            }
            if (typeof part.tokens.output === 'number' && !isNaN(part.tokens.output)) {
              outTokens += part.tokens.output;
              hasTokens = true;
            }
          }
        }
      } catch {
        // Not a JSON event
      }
    }

    if (stepCount > 0 && (hasCost || hasTokens)) {
      result.found = true;
      result.rawUsage = rawMatches.join('\n');
      if (hasCost) {
        result.usage = {
          amount: Number(costSum.toFixed(6)),
          unit: 'USD'
        };
      }
      if (hasTokens) {
        result.tokens = {
          in: Math.round(inTokens),
          out: Math.round(outTokens),
          source: 'client-output'
        };
      }
    }
  } else if (usageParser === 'copilot-credits') {
    let creditSum = 0;
    let count = 0;
    const rawMatches = [];
    for (const m of text.matchAll(/AI Credits\s+([0-9.]+)/g)) {
      const val = parseFloat(m[1]);
      if (!isNaN(val)) {
        creditSum += val;
        count++;
        rawMatches.push(m[0].trim());
      }
    }
    if (count > 0) {
      result.found = true;
      result.rawUsage = rawMatches.join('\n');
      result.usage = {
        amount: Number(creditSum.toFixed(6)),
        unit: 'credits'
      };
      result.tokens = { in: null, out: null, source: 'none' };
    }
  } else if (usageParser === 'codex-tokens') {
    let tokenSum = 0;
    let count = 0;
    const rawMatches = [];
    const codexRegex = /\btokens used\b\s*:?\s*([0-9](?:[0-9\u00A0 ,.]*[0-9kKmM])?|[0-9][kKmM])/gi;
    for (const m of text.matchAll(codexRegex)) {
      const val = parseCodexTokenNumber(m[1]);
      if (!isNaN(val)) {
        tokenSum += val;
        count++;
        rawMatches.push(m[0].trim());
      }
    }
    if (count > 0) {
      result.found = true;
      result.rawUsage = rawMatches.join('\n');
      result.usage = {
        amount: tokenSum,
        unit: 'tokens'
      };
      result.tokens = { in: null, out: null, source: 'none' };
    }
  }

  return result;
}

module.exports = { buildClientCommand, formatCommandLine, probeClient, probeAll, parseUsageFromLog, effortArgs };
