'use strict';
// Route price table: cheapest route per model with the others next to it.
// Blended price per million tokens = (wIn * input + wOut * output) / (wIn + wOut), exact decimal, rounded half up to 9 decimals.
// Default weights input:output = 3:1 (a coding task reads more than it writes), overridable, or taken from the farm records.

const fs = require('fs');
const D = require('./decimal.cjs');
const I = require('./price-ids.cjs');

const DEFAULT_WEIGHTS = { in: 3n, out: 1n, source: 'default 3:1' };
const BLEND_DIGITS = 9;

/** '3:1' or '4:1' -> weights; positive integers only. Throws on anything else. */
function parseWeights(spec) {
  const m = /^(\d{1,12}):(\d{1,12})$/.exec(String(spec || '').trim());
  if (!m || BigInt(m[1]) === 0n || BigInt(m[2]) === 0n) throw new Error(`weights must be two positive integers like 3:1, got ${JSON.stringify(spec)}`);
  return { in: BigInt(m[1]), out: BigInt(m[2]), source: `--weights ${m[1]}:${m[2]}` };
}

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

/**
 * Measured token ratio from the farm launch records (tokens.input and tokens.output per line).
 * @param {string} file FARM-RUNS.jsonl
 * @param {string|null} canonicalModel restrict to records whose tuple.model canonicalises to this id
 */
function weightsFromFarm(file, canonicalModel) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const sum = (model) => {
    let sin = 0n; let sout = 0n; let n = 0;
    for (const line of lines) {
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      const t = rec && rec.tokens;
      if (!t || !Number.isSafeInteger(t.input) || !Number.isSafeInteger(t.output) || t.input < 0 || t.output < 0) continue;
      if (model && I.canonicalize('farm', rec.tuple && rec.tuple.model).canonicalId !== model) continue;
      sin += BigInt(t.input); sout += BigInt(t.output); n++;
    }
    return { sin, sout, n };
  };
  let r = canonicalModel ? sum(canonicalModel) : null;
  let note = canonicalModel ? ` for ${canonicalModel}` : '';
  if (!r || r.n === 0 || r.sin === 0n || r.sout === 0n) {
    r = sum(null);
    note = canonicalModel ? ` (no farm records for ${canonicalModel}: all models used)` : '';
  }
  if (r.n === 0 || r.sin === 0n || r.sout === 0n) throw new Error(`no farm records with both input and output tokens in ${file}`);
  const g = gcd(r.sin, r.sout);
  return { in: r.sin / g, out: r.sout / g, source: `farm records ${r.n}${note}, input ${r.sin} : output ${r.sout} tokens` };
}

/** @returns {string|null} decimal text */
function blended(inputPerM, outputPerM, w) {
  const i = D.parse(inputPerM); const o = D.parse(outputPerM);
  if (!i || !o) return null;
  const sum = D.add(D.mulInt(i, w.in), D.mulInt(o, w.out));
  return D.toString(D.divInt(sum, w.in + w.out, BLEND_DIGITS));
}

/** Records that can be priced: language model, canonical id, both prices known. */
function priceable(records) {
  return records.filter((r) => r.canonicalId && r.modelType === 'language' && r.inputPerM !== null && r.outputPerM !== null);
}

function routeRow(r, w) {
  return {
    platform: r.platform, provider: r.provider, platformModelId: r.platformModelId, variant: r.variant, priceKind: r.priceKind,
    inputPerM: r.inputPerM, outputPerM: r.outputPerM, cachedInputPerM: r.cachedInputPerM, blendedPerM: blended(r.inputPerM, r.outputPerM, w),
    contextLength: r.contextLength, quantization: r.quantization, supportsTools: r.supportsTools, free: r.free, flags: r.flags,
  };
}

function cmpRows(a, b) {
  const c = D.cmp(D.parse(a.blendedPerM), D.parse(b.blendedPerM));
  if (c) return c;
  return (a.platform + (a.provider || '')) < (b.platform + (b.provider || '')) ? -1 : 1;
}

/** One model entry of the table. */
function modelEntry(canonicalId, recs, w) {
  // Vercel: the per-model endpoint records replace the list record of the same model (the list price is one price for the model).
  const hasEndpoints = new Set(recs.filter((r) => r.platform === 'vercel' && r.priceKind === 'endpoint').map((r) => r.platformModelId));
  const usable = recs.filter((r) => !(r.platform === 'vercel' && r.priceKind === 'list' && hasEndpoints.has(r.platformModelId)));
  const standard = usable.filter((r) => r.variant === 'standard' && !r.free).map((r) => routeRow(r, w));
  const free = usable.filter((r) => r.variant === 'free' || (r.free && r.variant === 'standard')).map((r) => routeRow(r, w));
  const other = usable.filter((r) => r.variant !== 'standard' && r.variant !== 'free').map((r) => routeRow(r, w));
  standard.sort(cmpRows);
  free.sort(cmpRows);
  const perPlatform = [];
  for (const row of standard) if (!perPlatform.some((p) => p.platform === row.platform)) perPlatform.push(row);
  const entry = {
    canonicalId,
    platforms: perPlatform.map((p) => p.platform),
    cheapest: perPlatform[0] || null,
    perPlatformCheapest: perPlatform,
    routes: standard,
    freeRoutes: free,
    otherVariants: other,
    spreadPercent: null,
    warning: null,
  };
  if (perPlatform.length >= 2) {
    entry.spreadPercent = D.isZero(D.parse(perPlatform[0].blendedPerM)) ? null : D.spreadPercent(D.parse(perPlatform[0].blendedPerM), D.parse(perPlatform[perPlatform.length - 1].blendedPerM), 1);
  }
  entry.warning = sameIdWarning(standard.concat(free));
  return entry;
}

function sameIdWarning(rows) {
  const q = [...new Set(rows.map((r) => r.quantization).filter((x) => x))].sort();
  const ctx = [...new Set(rows.map((r) => r.contextLength).filter((x) => x !== null))].sort((a, b) => a - b);
  const bits = [];
  bits.push(q.length ? `quantization seen: ${q.join(', ')}; rows that name none are unknown, not full precision` : 'quantization is not given by the price endpoints');
  if (ctx.length > 1) bits.push(`context lengths differ: ${ctx.join(' / ')}`);
  else if (ctx.length === 1) bits.push(`context ${ctx[0]}`);
  bits.push('rate limits and output caps are not in the price data');
  return `the same canonical id does not prove the same served model: ${bits.join('; ')}`;
}

/**
 * @param {object} snapshot loaded price-snapshot/1
 * @param {{weights?: object, model?: string|null, all?: boolean, ladderOnly?: boolean}} [opts]
 */
function buildTable(snapshot, opts) {
  const o = opts || {};
  const w = o.weights || DEFAULT_WEIGHTS;
  const by = new Map();
  for (const r of priceable(snapshot.records)) {
    if (o.model && r.canonicalId !== o.model) continue;
    if (!by.has(r.canonicalId)) by.set(r.canonicalId, []);
    by.get(r.canonicalId).push(r);
  }
  const ladder = new Set(I.LADDER_MODELS.map((m) => m.canonicalId));
  const entries = [];
  for (const [id, recs] of by) {
    const e = modelEntry(id, recs, w);
    e.ladder = ladder.has(id);
    const multi = new Set(recs.map((r) => r.platform)).size >= 2;
    if (o.model || o.all || multi || e.ladder) entries.push(e);
  }
  entries.sort((a, b) => (b.ladder - a.ladder) || (a.canonicalId < b.canonicalId ? -1 : 1));
  return { weights: { in: String(w.in), out: String(w.out), source: w.source }, formula: 'blended = (wIn * inputPerM + wOut * outputPerM) / (wIn + wOut), exact decimal, half up at 9 decimals; spread = (dearest platform - cheapest platform) / cheapest platform * 100 over each platform\'s cheapest standard non-free route', models: entries };
}

function fmtRow(r) {
  const who = `${r.platform}${r.provider ? `/${r.provider}` : ''}`.padEnd(28);
  return `  ${who} in ${r.inputPerM} out ${r.outputPerM} blended ${r.blendedPerM}${r.cachedInputPerM ? ` cached-in ${r.cachedInputPerM}` : ''}${r.contextLength ? ` ctx ${r.contextLength}` : ''}${r.quantization ? ` q=${r.quantization}` : ''}${r.flags.length ? ` [${r.flags.join(',')}]` : ''}`;
}

/** Plain text of a table. */
function renderText(table, snapshot) {
  const lines = [];
  lines.push(`route price table, snapshot ${snapshot.id} (captured ${snapshot.capturedAt}, hash ${snapshot.hash.slice(0, 12)}), weights input:output = ${table.weights.in}:${table.weights.out} (${table.weights.source}), USD per million tokens`);
  lines.push(`formula: ${table.formula}`);
  for (const m of table.models) {
    const head = m.cheapest ? `cheapest ${m.cheapest.platform}${m.cheapest.provider ? `/${m.cheapest.provider}` : ''} blended ${m.cheapest.blendedPerM}` : 'no paid route';
    lines.push('');
    lines.push(`${m.ladder ? '* ' : ''}${m.canonicalId}  platforms=${m.platforms.length}  ${head}  spread=${m.spreadPercent === null ? 'n/a' : `${m.spreadPercent}%`}`);
    for (const r of m.routes) lines.push(fmtRow(r));
    for (const r of m.freeRoutes) lines.push(`${fmtRow(r)}  FREE`);
    for (const r of m.otherVariants) lines.push(`${fmtRow(r)}  variant=${r.variant}`);
    lines.push(`  WARNING: ${m.warning}`);
  }
  lines.push('');
  lines.push(`models shown: ${table.models.length} (* = model of the ladder or the candidate matrix)`);
  return lines.join('\n');
}

module.exports = { DEFAULT_WEIGHTS, BLEND_DIGITS, parseWeights, weightsFromFarm, blended, priceable, routeRow, modelEntry, buildTable, renderText, sameIdWarning };
