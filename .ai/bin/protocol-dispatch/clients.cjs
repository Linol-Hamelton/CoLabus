'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { commandArgv } = require('../lib/command-argv.cjs');

function execClient(file, args) {
  const cmd = commandArgv(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return execFileSync(cmd.file, cmd.args, cmd.options);
}

function buildClientCommand(clientCfg, route, tokens, attemptKind = 'fresh') {
  const clientName = route?.client || clientCfg.id || clientCfg.binary;
  const appliedEffort = effortArgs(clientName, route?.effort, { clients: { [clientName]: clientCfg } }, { requireTemplate: true });
  if (!appliedEffort.ok) throw new Error(appliedEffort.error);
  const timeout = require('../lib/client-command-timeout.cjs');
  tokens = { ...tokens, message: timeout.append(tokens.message || '', timeout.forConfig(clientCfg)) };
  const parts = [];
  const expand = tok => {
    let s = tok;
    if (route && route.provider !== undefined) s = s.replaceAll('{provider}', String(route.provider));
    for (const [k, v] of Object.entries(tokens)) {
      if (v !== undefined && v !== null) {
        s = s.replaceAll(`{${k}}`, String(v));
      }
    }
    return s;
  };

  let cmdList = (attemptKind === 'resume' && clientCfg.resume && clientCfg.resume.command)
    ? clientCfg.resume.command
    : clientCfg.command;

  // Resume templates often omit the effort item. Reuse the fresh launch's
  // registry flag, before the message (which some clients treat as trailing argv).
  if (attemptKind === 'resume' && appliedEffort.args.length && !cmdList.some(i => i?.if === 'effort')) {
    cmdList = cmdList.slice();
    const messageIndex = cmdList.findIndex(i => typeof i === 'string' && i.includes('{message}'));
    cmdList.splice(messageIndex < 0 ? cmdList.length : messageIndex, 0, { if: 'effort', args: appliedEffort.args });
  }

  let messageExpanded = false;
  for (const item of cmdList) {
    if (typeof item === 'string') {
      if (item.includes('{message}')) messageExpanded = true;
      parts.push(expand(item));
    } else if (item && typeof item === 'object' && item.if) {
      if (route && route[item.if]) {
        for (const a of item.if === 'effort' ? appliedEffort.args : item.args || []) {
          if (a.includes('{message}')) messageExpanded = true;
          parts.push(expand(a));
        }
      }
    }
  }

  if (attemptKind === 'resume' && !messageExpanded && tokens.message) {
    parts.push(tokens.message);
  }

  if (clientCfg.binary === 'cline') require('../ops-tools/proxy-health.cjs').route({ client: 'cline', model: route.model, provider: route.provider, argv: parts });
  return parts;
}

// P-L3-005 (R-L3-005.1, .3, .6, .7): the effort flags of a launch come from the client registry, never from the launcher.
// flag/config with a value list: the value must be in effort.values (else ok=false: it is never requested) and the args are the
// registry's own {if: "effort"} template item; config without a value list (set in the client configuration), model-id (the
// effort is part of the model id), none and unknown: no flag, effortUsed null. An unregistered client gets no flag either.
// EFFORT-EXPLICIT: if the route supports efforts (effort.values is a non-null array) and no effort is given, the launch is refused
// with ok=false instead of falling back to the client default.
function effortArgs(clientName, effort, registry, options = {}) {
  const cfg = registry && registry.clients ? registry.clients[clientName] : null;
  if (!cfg) return { ok: true, args: [], effortUsed: null, how: 'unregistered', note: `client ${clientName} is not in the registry` };
  const e = cfg.effort || {};
  const how = e.how || 'unknown';
  if (!effort) {
    // EFFORT-EXPLICIT: refuse launch if the client supports explicit efforts (has non-null effort.values array)
    if ((how === 'flag' || how === 'config') && Array.isArray(e.values)) {
      return { ok: false, args: [], effortUsed: null, how, error: `effort is required for ${clientName}: route supports explicit efforts but none was provided` };
    }
    return { ok: true, args: [], effortUsed: null, how, note: 'no effort requested' };
  }
  if (how === 'flag' || how === 'config') {
    if (!Array.isArray(e.values)) return { ok: true, args: [], effortUsed: null, how, note: e.note || 'the registry lists no effort values for this client' };
    if (!e.values.includes(effort)) return { ok: false, args: [], effortUsed: null, how, error: `effort ${effort} is not in ${clientName}.effort.values (${e.values.join(', ')})` };
    const item = Array.isArray(cfg.command) ? cfg.command.find(i => i && typeof i === 'object' && i.if === 'effort') : null;
    // Selection inspects applicability without launching; dispatch must refuse
    // an unusable template before spawn instead of running on a client default.
    if (options.requireTemplate && (!item || !Array.isArray(item.args) || !item.args.length || !item.args.some(a => String(a).includes('{effort}')))) {
      return { ok: false, args: [], effortUsed: null, how, error: `effort-template-missing: ${clientName} has no usable effort item` };
    }
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
    const raw = execClient(clientCfg.binary, ['--version']);
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
      const listOut = execClient(listCmd, listArgs);
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

// A codex token count is one whole token: the whole count of the codex banner reader (client-usage.cjs wholeCount: an
// integer, or the same integer grouped in threes by one separator), or a count with at most two decimals and a K or M
// suffix. Anything else that starts like a number (a sign, an exponent, a group that is not three digits, text after the
// figure) is NaN: it measures nothing. Every whitespace character but a line end is the same space (PUB-FIX4 pfx4g).
const CODEX_SUFFIXED = /^([0-9]+)(?:[.,]([0-9]{1,2}))?[^\S\r\n]?([kKmM])$/;
const codexText = () => require('../accounting/lib/client-usage.cjs');
function parseCodexTokenNumber(str) {
  if (typeof str !== 'string') return NaN;
  const token = str.trim();
  const whole = codexText().wholeCount(token);
  if (!Number.isNaN(whole)) return whole;
  const suffixed = CODEX_SUFFIXED.exec(token);
  if (!suffixed) return NaN;
  const mult = suffixed[3].toUpperCase() === 'K' ? 1000 : 1000000;
  return Math.round(Number(`${suffixed[1]}.${suffixed[2] || '0'}`) * mult);
}
// Copilot prints one "AI Credits" figure per line: digits with at most one decimal part, as one whole token. Whatever
// follows the label is its figure: a word, a sign or a number split by a space (1 234) is no figure, and a total beyond
// the safe integer range is unknown (a figure beyond it makes the total so). Every whitespace character is that space
// (U+2009, U+3000 or U+2028 as much as a no-break space: PUB-FIX4 pfx4g, DeepSeek p6d942 C).
const COPILOT_CREDITS = /^[0-9]+(?:\.[0-9]+)?$/;
const COPILOT_SPLIT = /^\s+[\p{Nd}.+\-\u2010-\u2015\u2212\uFE63\uFF0B\uFF0D]/u;

// A measured figure is a finite number that is not negative. A negative value, an infinity or a
// non-number measures nothing: the figure it belongs to stays unknown, and a total that is not
// finite is unknown too, never a number.
const measured = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

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
    // A figure is measured only when every step-finish event states it: a step that omits cost, input or output leaves that figure unknown (null),
    // never a zero and never the sum of the steps that did state it.
    let costSum = 0;
    let inTokens = 0;
    let outTokens = 0;
    let stepCount = 0;
    let costSteps = 0;
    let inSteps = 0;
    let outSteps = 0;
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
          if (measured(part.cost)) {
            costSum += part.cost;
            costSteps++;
          }
          // A token count is one whole count in the safe integer range (a fraction or a rounded huge number is none).
          if (part.tokens && typeof part.tokens === 'object') {
            if (Number.isSafeInteger(part.tokens.input) && part.tokens.input >= 0) {
              inTokens += part.tokens.input;
              inSteps++;
            }
            if (Number.isSafeInteger(part.tokens.output) && part.tokens.output >= 0) {
              outTokens += part.tokens.output;
              outSteps++;
            }
          }
        }
      } catch {
        // Not a JSON event
      }
    }

    const hasCost = stepCount > 0 && costSteps === stepCount && measured(costSum);
    const hasIn = stepCount > 0 && inSteps === stepCount && Number.isSafeInteger(inTokens);
    const hasOut = stepCount > 0 && outSteps === stepCount && Number.isSafeInteger(outTokens);
    if (stepCount > 0 && (hasCost || hasIn || hasOut)) {
      result.found = true;
      result.rawUsage = rawMatches.join('\n');
      if (hasCost) {
        result.usage = {
          amount: Number(costSum.toFixed(6)),
          unit: 'USD'
        };
      }
      if (hasIn || hasOut) {
        result.tokens = {
          in: hasIn ? inTokens : null,
          out: hasOut ? outTokens : null,
          source: 'client-output'
        };
      }
    }
  } else if (usageParser === 'copilot-credits') {
    // A figure that starts like a number and is not a whole credits token (a sign, an exponent, a second dot, text glued to
    // it) measures nothing, and then the total is unknown: the other figures are not the whole cost. Every label is read
    // (PUB-FIX4 pfx4g, Sol p6s940 F3): a label with no figure (the end of the text, spaces only, text glued to it) is a
    // label without its figure, never skipped, and a second label on the line is a label of its own, never a note.
    let creditSum = 0;
    let count = 0;
    let unreadable = false;
    const rawMatches = [];
    const label = /AI Credits\s+(\S+)([^\r\n]*)/y;
    for (const { index } of text.matchAll(/AI Credits/g)) {
      label.lastIndex = index;
      const m = label.exec(text);
      if (!m || !COPILOT_CREDITS.test(m[1]) || COPILOT_SPLIT.test(m[2])) { unreadable = true; continue; }
      creditSum += Number(m[1]);
      count++;
      rawMatches.push(m[0].slice(0, m[0].length - m[2].length).trim());
    }
    if (count > 0 && !unreadable && measured(creditSum) && creditSum <= Number.MAX_SAFE_INTEGER) {
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
    let unreadable = false;
    const rawMatches = [];
    // The labels are the banner reader's one label rule (client-usage.cjs codexLabels). A label's figure that is not one
    // whole count measures nothing, and then the total is unknown; so is a total beyond the safe integer range (a figure
    // beyond it, which Number would round, makes the total unsafe too: the figures are not negative).
    for (const label of codexText().codexLabels(text)) {
      const val = parseCodexTokenNumber(label.figure);
      if (isNaN(val)) { unreadable = true; continue; }
      tokenSum += val;
      count++;
      rawMatches.push(label.text.trim());
    }
    if (count > 0 && !unreadable && Number.isSafeInteger(tokenSum)) {
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
