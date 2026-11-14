'use strict';
// Parsers of the three public price endpoints into price records (schema/price-snapshot.json).
// Supported shapes of route pricing responses:
//   OpenRouter  GET models endpoint            {data:[{id, canonical_slug, context_length, pricing:{prompt, completion, input_cache_read,...}}]}, prices are decimal STRINGS per token
//   Vercel      GET models endpoint                {data:[{id, type, context_window, pricing:{input, output, input_cache_read,...}}]}, decimal STRINGS per token
//   Vercel      GET models endpoint/{c}/{m}/endpoints {data:{id, endpoints:[{provider_name, pricing:{prompt, completion,...}, quantization, context_length}]}}, STRINGS per token
//   Hugging Face GET router models endpoint        {data:[{id, providers:[{provider, pricing:{input, output}, context_length, supports_tools, is_free}]}]}, JSON NUMBERS per MILLION
// A field the endpoint does not give is null, never guessed.

const D = require('./decimal.cjs');

const HF_DECIMALS = 9;

function priceFromTokenText(text, flags, label) {
  if (text === undefined || text === null) return null;
  const d = D.parse(String(text));
  if (!d) { flags.push(`price-unparsable:${label}`); return null; }
  if (D.isNegative(d)) { flags.push(`dynamic-price:${label}`); return null; }
  return D.toString(D.shift10(d, 6));
}

function modelTypeFromModalities(out) {
  if (!Array.isArray(out)) return null;
  return out.length === 1 && out[0] === 'text' ? 'language' : 'other';
}

function isZeroPair(i, o) { return i === '0' && o === '0'; }

/** Parse JSON keeping the source text of the numbers named input / output (HF prices are JSON numbers with float drift). */
function parseJsonKeepingPriceText(text) {
  return JSON.parse(text, (k, v, ctx) => {
    if (typeof v === 'number' && (k === 'input' || k === 'output') && ctx && typeof ctx.source === 'string') return { __src: ctx.source };
    return v;
  });
}

function hfPrice(v, flags, label) {
  if (v === undefined || v === null) return null;
  const src = typeof v === 'object' && v.__src !== undefined ? v.__src : (typeof v === 'number' ? String(v) : null);
  const d = src === null ? null : D.parse(src);
  if (!d) { flags.push(`price-unparsable:${label}`); return null; }
  if (D.isNegative(d)) { flags.push(`dynamic-price:${label}`); return null; }
  if (d.s > HF_DECIMALS) { flags.push(`rounded-${HF_DECIMALS}dp:${label}`); return D.toString(D.round(d, HF_DECIMALS)); }
  return D.toString(d);
}

function base(platform, meta, id) {
  return {
    platform, platformModelId: id, platformSlug: null, canonicalId: null, canonicalVia: null, variant: 'standard',
    provider: null, priceKind: 'list', modelType: null,
    inputPerM: null, outputPerM: null, cachedInputPerM: null,
    contextLength: null, quantization: null, supportsTools: null, free: false,
    flags: [], fetchedAt: meta.fetchedAt, sourceUrl: meta.sourceUrl, rawSha256: meta.rawSha256,
  };
}

function intOrNull(v) { return Number.isSafeInteger(v) ? v : null; }

/** @returns {object[]} */
function parseOpenRouter(text, meta) {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.data)) throw new Error('openrouter: no data array');
  return j.data.map((m) => {
    const r = base('openrouter', meta, String(m.id));
    const p = m.pricing || {};
    r.platformSlug = typeof m.canonical_slug === 'string' ? m.canonical_slug : null;
    r.inputPerM = priceFromTokenText(p.prompt, r.flags, 'input');
    r.outputPerM = priceFromTokenText(p.completion, r.flags, 'output');
    r.cachedInputPerM = priceFromTokenText(p.input_cache_read, r.flags, 'cached');
    r.contextLength = intOrNull(m.context_length);
    r.supportsTools = Array.isArray(m.supported_parameters) ? m.supported_parameters.includes('tools') : null;
    r.modelType = modelTypeFromModalities(m.architecture && m.architecture.output_modalities);
    r.free = /:free$/.test(r.platformModelId) || isZeroPair(r.inputPerM, r.outputPerM);
    if (m.pricing && typeof m.pricing === 'object' && Object.keys(m.pricing).some((k) => /overrides/.test(k))) r.flags.push('price-overrides');
    if (m.expiration_date) r.flags.push('expires');
    return r;
  });
}

/** @returns {object[]} */
function parseVercelList(text, meta) {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.data)) throw new Error('vercel: no data array');
  return j.data.map((m) => {
    const r = base('vercel', meta, String(m.id));
    const p = m.pricing || {};
    r.inputPerM = priceFromTokenText(p.input, r.flags, 'input');
    r.outputPerM = priceFromTokenText(p.output, r.flags, 'output');
    r.cachedInputPerM = priceFromTokenText(p.input_cache_read, r.flags, 'cached');
    r.contextLength = intOrNull(m.context_window);
    r.modelType = typeof m.type === 'string' ? m.type : null;
    if (Array.isArray(m.supported_parameters)) r.supportsTools = m.supported_parameters.includes('tools');
    else if (Array.isArray(m.tags)) r.supportsTools = m.tags.includes('tool-use');
    r.free = isZeroPair(r.inputPerM, r.outputPerM);
    if (p.varies_by_provider) r.flags.push('varies-by-provider');
    if (p.input_tiers || p.output_tiers) r.flags.push('tiered-price');
    if (p.peak_pricing) r.flags.push('peak-pricing');
    if (m.deprecated_at) r.flags.push('deprecated');
    return r;
  });
}

/** One records per endpoint (provider) of one Vercel model. @returns {object[]} */
function parseVercelEndpoints(text, meta) {
  const j = JSON.parse(text);
  if (!j || !j.data || !Array.isArray(j.data.endpoints)) throw new Error('vercel endpoints: no data.endpoints array');
  const id = String(j.data.id);
  return j.data.endpoints.map((e) => {
    const r = base('vercel', meta, id);
    const p = e.pricing || {};
    r.provider = typeof e.provider_name === 'string' ? e.provider_name : null;
    r.priceKind = 'endpoint';
    r.inputPerM = priceFromTokenText(p.prompt, r.flags, 'input');
    r.outputPerM = priceFromTokenText(p.completion, r.flags, 'output');
    r.cachedInputPerM = priceFromTokenText(p.input_cache_read, r.flags, 'cached');
    r.contextLength = intOrNull(e.context_length);
    r.quantization = typeof e.quantization === 'string' ? e.quantization : null;
    if (Array.isArray(e.supported_parameters)) r.supportsTools = e.supported_parameters.includes('tools');
    r.modelType = modelTypeFromModalities(j.data.architecture && j.data.architecture.output_modalities);
    r.free = isZeroPair(r.inputPerM, r.outputPerM);
    if (p.peak_pricing) r.flags.push('peak-pricing');
    if (typeof p.discount === 'number' && p.discount !== 0) r.flags.push('discount');
    if (Array.isArray(e.inference_regions) && e.inference_regions.length) r.flags.push('regional-price');
    return r;
  });
}

/** One record per provider of every model. @returns {object[]} */
function parseHuggingFace(text, meta) {
  const j = parseJsonKeepingPriceText(text);
  if (!j || !Array.isArray(j.data)) throw new Error('huggingface: no data array');
  const out = [];
  for (const m of j.data) {
    const provs = Array.isArray(m.providers) ? m.providers : [];
    const modelType = modelTypeFromModalities(m.architecture && m.architecture.output_modalities);
    for (const pr of provs) {
      const r = base('huggingface', meta, String(m.id));
      r.provider = typeof pr.provider === 'string' ? pr.provider : null;
      r.priceKind = 'endpoint';
      r.modelType = modelType;
      const p = pr.pricing || null;
      if (p) {
        r.inputPerM = hfPrice(p.input, r.flags, 'input');
        r.outputPerM = hfPrice(p.output, r.flags, 'output');
      } else r.flags.push('no-price');
      r.contextLength = intOrNull(pr.context_length);
      if (typeof pr.supports_tools === 'boolean') r.supportsTools = pr.supports_tools;
      r.free = pr.is_free === true || isZeroPair(r.inputPerM, r.outputPerM);
      if (pr.is_free !== true && isZeroPair(r.inputPerM, r.outputPerM)) r.flags.push('free-by-price-only');
      if (pr.status && pr.status !== 'live') r.flags.push(`status:${pr.status}`);
      out.push(r);
    }
  }
  return out;
}

module.exports = { parseOpenRouter, parseVercelList, parseVercelEndpoints, parseHuggingFace, parseJsonKeepingPriceText, HF_DECIMALS };
