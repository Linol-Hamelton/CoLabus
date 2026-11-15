'use strict';
// certifier-select.cjs - deterministic recommendation of certifier seats for a candidate
// (an owner rule: nothing about who certifies is written by hand). Under that rule
// nothing about who certifies is written by hand beyond the closed constraints, which live in
// the constraints file of the host (data, each row with its stated reason); this tool computes
// the ordered eligible seats from the selection layer and RECOMMENDS ONLY (shadow): the real
// dispatch asks the owner. Advisory: never Evidence.
//
//   node docs/ops/certifier-select.cjs --root <repo> --author <modelId> [--author-transport <client>]
//        [--fixer <modelId> [--fixer-transport <client>]] [--operator <modelId> [--operator-transport <client>]]
//        [--class A|B] [--routes <file>] [--constraints <file>] [--json]
//     exit 0  the recommendation was computed (an empty eligible list is a valid result)
//     exit 2  unusable or corrupt input: missing root/author, an unsafe argument value, a file
//             that does not parse, a route reached through a link, a corrupt launch-record line,
//             a missing or malformed constraints file (fail-closed: never an open default).
//
// The pure function selectCertifiers(input) holds every decision; the CLI only assembles its input
// from repository files, all located through --root (no hard-coded path):
//   models       data/model-classes.json of the launch-record layer (selection layer;
//                read READ-ONLY for the recommendation connection)
//   routes       .ai/docs/clients.json (a seat's route is positively available when the client is
//                present and POSITIVELY LISTS the model), or an operator --routes file
//                (schema cert-routes/1) that must positively list models too and can carry budgets
//   evidence     the launch corpus, launches/ of the launch-record layer
//                (LAUNCHES.jsonl and pending/*.jsonl): a record proves the served model of a route
//                by the seat-check semantics; a record that requested this model and recorded a
//                mismatch CONTRADICTS the seat (unknown never becomes eligible)
//   constraints  the constraints file (the closed maker exclusions and only what the owner adds; every
//                row must carry a basis, an empty set is refused)
//
// The shared guards library is
// USED - .ai/bin/lib/path-safe.cjs for every real path (links,
// junctions and reparse points below the root are refused), .ai/bin/lib/text-safe.cjs for
// decoding; the private copies are gone. Closed positive grammar everywhere: a route proves the
// seat only when it positively lists the model (an absent or empty models list is unknown, never
// a pass); a malformed budget excludes; a model of unknown maker is excluded (maker-unknown, the
// closed exclusions cannot be positively checked); lineage is the modelsMatch identity (an alias
// of the author never certifies); duplicate route rows that disagree make the route conflicting
// (never the first row); evidence contradictions (a mismatch launch of this model on this route)
// exclude the seat; the proof recorded on an eligible seat is canonical (order-independent).
// No hand-written maker or model names live in this file (the same owner rule).
//
// Exclusion reasons form the closed set: lineage, add60-maker-exclusion, maker-unknown,
// route-unavailable, served-model-unproven (and, for Class A pairs: same-transport, same-model).

const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const { secretIn } = require('../../.ai/bin/lib/secrets.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { makerMatches } = require('../../.ai/bin/lib/maker-fold.cjs');
const { modelsMatch, vibeAlias } = require('./served-model.cjs');
// A vibe export names the configured model or its served revision; the selection seat uses the launch alias.
const routeModelsMatch = (transport, a, b) => transport === 'vibe'
  ? modelsMatch(vibeAlias(a).alias, vibeAlias(b).alias) : modelsMatch(a, b);

const PROOF_SOURCES = ['agent-result', 'client-banner', 'client-log', 'launcher-model']; // served-model.cjs SOURCES minus 'none' (the launcher flag is a proven source)
const PROOF_CONFIDENCE = ['exact', 'derived']; // served-model.cjs CONFIDENCE minus 'none'
const DEFAULT_SCORE_DIMENSIONS = ['D-REV', 'D-CRIT']; // stated reason: certification is review+critique work
const SECRET_RE = /\bsk-[A-Za-z0-9_-]{20,}|\b\d{6,}:[A-Za-z0-9_-]{30,}/;
// A value is secret-shaped by this local form or by the one shared secret scan (every key, token and private key header).
const secretShaped = value => SECRET_RE.test(value) || secretIn(value);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~@:/-]{0,179}$/;

class CorruptError extends Error {
  constructor(message) { super(message); this.corrupt = true; }
}

// A domain error's message is fixed text written in this file; it never embeds an input value,
// so the CLI may print it verbatim (an unexpected error's message is never printed unfiltered).
class DomainError extends Error {
  constructor(message) { super(message); this.domain = true; }
}

function normId(s) { return String(s || '').trim().toLowerCase(); }


function safeLabel(value) {
  const s = String(value);
  if (secretShaped(s)) return '<unsafe value>';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,180}$/.test(s) || s.length > 200) return '<unsafe value>';
  return s;
}

// Every identifier that can reach an output is scanned: a secret-shaped or unsafe value corrupts
// the input instead of flowing into any message or output (defect class 8).
function assertSafeId(value, what) {
  const s = String(value);
  if (secretShaped(s)) throw new CorruptError(`corrupt: ${what} is secret-shaped (not echoed)`);
  if (!SAFE_ID_RE.test(s)) throw new CorruptError(`corrupt: ${what} is not a safe identifier (not echoed)`);
  return s;
}

// A constraints basis is prose that reaches the output detail; only its secret shape is checked.
function assertSafeProse(value, what) {
  const s = String(value);
  if (secretShaped(s)) throw new CorruptError(`corrupt: ${what} is secret-shaped (not echoed)`);
  if (s.length > 500) throw new CorruptError(`corrupt: ${what} is too long (not echoed)`);
  return s;
}

function requireInput(input) {
  if (!input || typeof input !== 'object') throw new DomainError('input object required');
  if (!input.candidate || typeof input.candidate !== 'object') throw new DomainError('candidate required (author, fixer, operator identities)');
  if (!input.candidate.author || typeof input.candidate.author.model !== 'string' || !input.candidate.author.model) {
    throw new DomainError('candidate.author.model required');
  }
  if (input.riskClass !== 'A' && input.riskClass !== 'B') throw new DomainError('riskClass must be A or B');
  if (!input.layer || typeof input.layer !== 'object') throw new DomainError('layer required');
  if (!Array.isArray(input.layer.models)) throw new DomainError('layer.models required');
  if (!Array.isArray(input.layer.routes)) throw new DomainError('layer.routes required');
  if (!input.constraints || !Array.isArray(input.constraints.excludedMakers)) {
    throw new DomainError('constraints.excludedMakers required (fail-closed: an absent constraint set never opens eligibility)');
  }
  // The closed hand-written set is part of the input domain: every row carries a stated
  // basis, and an empty set is refused - the standing closed constraints may not silently
  // disappear and open eligibility.
  if (!input.constraints.excludedMakers.length) {
    throw new DomainError('constraints.excludedMakers is empty: the closed hand-written set of maker exclusions may not silently disappear');
  }
  for (const row of input.constraints.excludedMakers) {
    if (!row || typeof row !== 'object' || typeof row.maker !== 'string' || !row.maker.trim()) {
      throw new DomainError('a constraints row carries no maker string');
    }
    if (typeof row.basis !== 'string' || !row.basis.trim()) {
      throw new DomainError('a constraints row carries no basis; a row without a stated reason is refused');
    }
  }
}

function seatScore(model, scoreDimensions) {
  const dims = Array.isArray(scoreDimensions) && scoreDimensions.length ? scoreDimensions : DEFAULT_SCORE_DIMENSIONS;
  const values = [];
  const strengths = (model && model.strengths) || {};
  for (const dim of dims) {
    if (!Object.prototype.hasOwnProperty.call(strengths, dim)) continue;
    const v = strengths[dim];
    if (v === null || v === undefined) continue; // no data for this dimension stays no data
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null; // an invalid component makes the total unknown
    values.push(v);
  }
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Route rows grouped by identity: identical duplicates collapse; rows that disagree make
// the route conflicting for every model on it (never the first row, never the newest).
function routeIndex(routes) {
  const index = new Map();
  for (const r of routes) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) continue; // not a route row for any transport
    const key = normId(r.id);
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  const out = new Map();
  for (const [key, rows] of index) {
    const shapes = new Set(rows.map(r => canonicalJson(r)));
    if (shapes.size > 1) out.set(key, { conflict: true, row: null });
    else out.set(key, { conflict: false, row: rows[0] });
  }
  return out;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) || 'null';
}

// The evidence rows that are ABOUT this seat. The subject of a row is the model whose launch it
// was: the requested model when the corpus recorded it; else the served model when the recorded
// match is true (requested equals served) or absent (the proof grammar re-checks the served model
// anyway); a row with match false and no requested model is about an UNKNOWN model (the requested
// model differed from the served one) and contradicts no one.
function evidenceRowsAbout(model, transport, evidence) {
  return (evidence || []).filter(e => {
    if (!e || typeof e !== 'object' || normId(e.transport) !== normId(transport)) return false;
    let subject = null;
    if (typeof e.requested === 'string' && e.requested) subject = e.requested;
    else if (e.match === false) return false;
    else subject = e.servedModel;
    if (typeof subject !== 'string' || !subject) return false;
    return routeModelsMatch(transport, model.id, subject) === true;
  });
}

// A proof positively proves the served model; a row that requested this model and recorded a
// mismatch contradicts the seat (PROTO-DEC-0169 item 4: unknown never becomes eligible).
function seatEvidence(model, transport, evidence) {
  const about = evidenceRowsAbout(model, transport, evidence);
  const proofs = about.filter(e =>
    typeof e.servedModel === 'string' && e.servedModel &&
    PROOF_SOURCES.includes(e.source) &&
    PROOF_CONFIDENCE.includes(e.confidence) &&
    e.match !== false &&
    routeModelsMatch(transport, model.id, e.servedModel) === true);
  const contradictions = about.filter(e => e.match === false);
  return { about, proofs, contradictions };
}

const canonProofKey = p => `${p.launchId || ''}|${p.source}|${p.confidence}`;
const minProof = (a, b) => (canonProofKey(a) <= canonProofKey(b) ? a : b);

// every exclusion of one seat, in a fixed order; the first axis that fails names the reason and
// the seat is excluded (the remaining axes are still checked so the reason list is complete).
function seatExclusions(model, transport, input, route) {
  const reasons = [];
  const push = (reason, detail) => {
    const key = `${reason}|${detail}`;
    if (!reasons.some(r => `${r.reason}|${r.detail}` === key)) reasons.push({ reason, detail });
  };
  const roles = [];
  for (const role of ['author', 'fixer', 'operator']) {
    const identity = input.candidate[role];
    // Lineage is the modelsMatch identity: an alias of the author's model never certifies.
    if (identity && typeof identity.model === 'string' && identity.model && modelsMatch(identity.model, model.id) === true) roles.push(role);
  }
  if (roles.length) push('lineage', `candidate ${roles.join('+')} model identity`);
  if (typeof model.maker !== 'string' || !model.maker.trim()) {
    // The closed maker exclusions cannot be positively checked: unknown never becomes eligible.
    push('maker-unknown', 'the maker is unknown, so the closed maker exclusions cannot be positively checked');
  }
  for (const row of input.constraints.excludedMakers) {
    if (row && typeof row.maker === 'string' && makerMatches(row.maker, model.maker)) {
      push('add60-maker-exclusion', `maker ${model.maker}: ${String(row.basis)}`);
    }
  }
  if (route.conflict) {
    push('route-unavailable', `conflicting duplicate route rows for transport ${transport}`);
  } else {
    const routeRow = route.row;
    if (!routeRow) push('route-unavailable', `no route entry for transport ${transport}`);
    else {
      if (routeRow.available !== true) {
        push('route-unavailable', routeRow.available === false ? 'marked unavailable' : 'availability unknown');
      }
      // Closed positive grammar: the route must POSITIVELY list the model; an absent,
      // empty or non-matching models list is unknown, never a pass.
      if (!Array.isArray(routeRow.models) || !routeRow.models.some(m => normId(m) === normId(model.id))) {
        push('route-unavailable', `transport ${transport} does not positively list model ${model.id}`);
      }
      if (Object.prototype.hasOwnProperty.call(routeRow, 'budgetRemainingUsd') && routeRow.budgetRemainingUsd !== null && routeRow.budgetRemainingUsd !== undefined) {
        const b = routeRow.budgetRemainingUsd;
        if (typeof b !== 'number' || !Number.isFinite(b)) {
          push('route-unavailable', 'budget remaining is malformed (not a finite number; unknown never becomes a pass)');
        } else if (b < 0) {
          push('route-unavailable', `budget remaining ${b} is negative`);
        } else if (b <= 0) {
          push('route-unavailable', `budget remaining ${b} is not positive`);
        }
      }
    }
  }
  const { about, proofs, contradictions } = seatEvidence(model, transport, model.servedModelEvidence);
  if (contradictions.length) {
    push('served-model-unproven', `recorded evidence for transport ${transport} contradicts the seat (a launch of this model on this route served a different model)`);
  } else if (!proofs.length) {
    push('served-model-unproven', about.length
      ? `no proven served-model evidence for transport ${transport} (recorded evidence fails the proof grammar: source, confidence, match or served model)`
      : `no proven served-model evidence for this route (no recorded evidence for this model on transport ${transport})`);
  }
  return { reasons, proof: proofs.reduce((a, b) => (a ? minProof(a, b) : b), null) };
}

function seatOrder(a, b) {
  const scoreA = a.score === null ? 1 : 0;
  const scoreB = b.score === null ? 1 : 0;
  if (scoreA !== scoreB) return scoreA - scoreB; // null scores last
  if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
  const byModel = normId(a.model) < normId(b.model) ? -1 : normId(a.model) > normId(b.model) ? 1 : 0;
  if (byModel !== 0) return byModel;
  return normId(a.transport) < normId(b.transport) ? -1 : 1; // stable tie-break
}

function pairScore(a, b) {
  if (a.score === null || b.score === null) return null;
  return a.score + b.score;
}

function pairOrder(a, b) {
  const nullA = a.score === null ? 1 : 0;
  const nullB = b.score === null ? 1 : 0;
  if (nullA !== nullB) return nullA - nullB;
  if (a.score !== null && b.score !== null && a.score !== b.score) return b.score - a.score;
  const ka = `${normId(a.first.model)}|${normId(a.first.transport)}|${normId(a.second.model)}|${normId(a.second.transport)}`;
  const kb = `${normId(b.first.model)}|${normId(b.first.transport)}|${normId(b.second.model)}|${normId(b.second.transport)}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// input = { candidate: { author|fixer|operator: { model, transport }|null }, riskClass: 'A'|'B',
//           layer: { models: [{ id, maker, transports, strengths, servedModelEvidence }], scoreDimensions? ,
//                    routes: [{ id, available, models?, budgetRemainingUsd? }] },
//           constraints: { excludedMakers: [{ maker, basis }] } }
// The same input always yields the same output (no clock, no randomness, sorted everywhere); the
// output does not depend on the order of models, routes or evidence rows.
function selectCertifiers(input) {
  requireInput(input);
  const layer = input.layer;
  const routes = routeIndex(layer.routes);
  const excluded = [];
  const eligible = [];

  for (const model of layer.models) {
    if (!model || typeof model.id !== 'string' || !model.id) continue;
    const transports = Array.isArray(model.transports) && model.transports.length
      ? model.transports.map(String).sort((a, b) => (a < b ? -1 : 1))
      : [];
    if (!transports.length) {
      excluded.push({ model: model.id, transport: null, reason: 'route-unavailable', detail: 'the model has no transport in the selection layer' });
      continue;
    }
    const score = seatScore(model, layer.scoreDimensions);
    for (const transport of transports) {
      const route = routes.get(normId(transport)) || { conflict: false, row: null };
      const { reasons, proof } = seatExclusions(model, transport, input, route);
      if (reasons.length) {
        for (const r of reasons) excluded.push({ model: model.id, transport, reason: r.reason, detail: r.detail });
        continue;
      }
      eligible.push({
        model: model.id,
        transport,
        maker: typeof model.maker === 'string' ? model.maker : null,
        score,
        budgetRemainingUsd: route.row && typeof route.row.budgetRemainingUsd === 'number' && Number.isFinite(route.row.budgetRemainingUsd) ? route.row.budgetRemainingUsd : null,
        evidence: { source: proof.source, confidence: proof.confidence || null, launchId: proof.launchId || null }
      });
    }
  }

  eligible.sort(seatOrder);
  const ordered = eligible.map(s => ({ ...s }));
  excluded.sort((x, y) => {
    const kx = `${normId(x.model)}|${normId(x.transport)}|${x.reason}|${x.detail}`;
    const ky = `${normId(y.model)}|${normId(y.transport)}|${y.reason}|${y.detail}`;
    return kx < ky ? -1 : kx > ky ? 1 : 0;
  });

  const pairs = [];
  const pairExcluded = [];
  if (input.riskClass === 'A') {
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const b = ordered[j];
        // Independence by identity: the same model under an alias never pairs with itself.
        const reason = normId(a.transport) === normId(b.transport) ? 'same-transport'
          : modelsMatch(a.model, b.model) === true ? 'same-model' : null;
        if (reason) { pairExcluded.push({ first: { model: a.model, transport: a.transport }, second: { model: b.model, transport: b.transport }, reason }); continue; }
        pairs.push({ first: { model: a.model, transport: a.transport }, second: { model: b.model, transport: b.transport }, score: pairScore(a, b) });
      }
    }
    pairs.sort(pairOrder);
    pairExcluded.sort((x, y) => {
      const kx = `${normId(x.first.model)}|${normId(x.first.transport)}|${normId(x.second.model)}|${normId(x.second.transport)}|${x.reason}`;
      const ky = `${normId(y.first.model)}|${normId(y.first.transport)}|${normId(y.second.model)}|${normId(y.second.transport)}|${y.reason}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
  }

  return {
    riskClass: input.riskClass,
    mode: 'recommend-shadow',
    dispatch: 'ASK_OWNER',
    ordered,
    excluded,
    pairs,
    pairExcluded,
    scoreDimensions: Array.isArray(layer.scoreDimensions) && layer.scoreDimensions.length ? layer.scoreDimensions : DEFAULT_SCORE_DIMENSIONS
  };
}

// ---- CLI assembly ----

function decodeStrict(bytes, label) {
  const d = textSafe.decode(bytes, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) {
    const codes = d.problems.map(p => p.code).join(', ');
    throw new CorruptError(`corrupt: ${label} is not decodable text (${codes})`);
  }
  return d.text;
}

function readJson(realPath, label) {
  let bytes;
  try { bytes = fs.readFileSync(realPath); } catch (e) { throw new CorruptError(`corrupt: required file ${label} cannot be read (${safeLabel(e.code || 'error')})`); }
  try { return JSON.parse(decodeStrict(bytes, label)); } catch (e) {
    if (e && e.corrupt) throw e;
    throw new CorruptError(`corrupt: ${label} does not parse as JSON`);
  }
}

// A file under the root: the path-safe guard walks every segment below the root's real path and
// refuses links, junctions and reparse points; the label in a message is the root-relative path.
function guardFileUnder(rootReal, relPath, label) {
  const g = pathSafe.realInside(rootReal, relPath);
  if (!g.ok) throw new CorruptError(`corrupt: ${label} is refused by the path guard (${g.reason})`);
  if (!g.exists) throw new CorruptError(`corrupt: required file ${label} not found under the root`);
  if (g.type !== 'file') throw new CorruptError(`corrupt: ${label} is not a regular file`);
  return g.real;
}

// An operator-provided file (anywhere the operator chose, like the root itself): the file must be
// a real file inside its own directory, not a link and not a hardlink.
function guardOperatorFile(file) {
  const abs = path.resolve(file);
  const g = pathSafe.realInside(path.dirname(abs), path.basename(abs), { refuseHardlinks: true });
  if (!g.ok) throw new CorruptError(`corrupt: the operator file is refused by the path guard (${g.reason})`);
  if (!g.exists) throw new CorruptError('unusable: the operator file does not exist');
  if (g.type !== 'file') throw new CorruptError('corrupt: the operator file is not a regular file');
  return g.real;
}

function layerFromModelClasses(data, label) {
  if (!data || !Array.isArray(data.models)) throw new CorruptError(`corrupt: ${label} holds no models array`);
  return data.models.map(m => {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) {
      throw new CorruptError(`corrupt: ${label} holds a model row without an id`);
    }
    assertSafeId(m.id, 'a selection layer model id');
    const maker = typeof m.maker === 'string' && m.maker.trim() ? m.maker : null;
    // a maker is a company name that reaches the exclusion details: it gets the prose check
    // (secret shape and length), not the identifier grammar - the real layer carries
    // "Zhipu AI (Z.ai)" and must keep reading.
    if (maker !== null) assertSafeProse(maker, 'a selection layer maker name');
    const transports = Array.isArray(m.routes) ? m.routes.map(t => assertSafeId(t, 'a selection layer transport name')) : [];
    const strengths = Object.fromEntries(Object.entries((m.public && m.public.dimensions) || {})
      .map(([dim, v]) => [dim, v && typeof v.strength !== 'undefined' ? v.strength : null]));
    return {
      id: m.id,
      maker,
      transports,
      strengths,
      classes: Array.isArray(m.classes) ? m.classes.map(c => c && c.class) : []
    };
  });
}

function routesFromClients(registry, routesData, clientsLabel, routesLabel) {
  if (!registry || registry.schema !== 'clients/1' || !registry.clients || typeof registry.clients !== 'object') {
    throw new CorruptError(`corrupt: ${clientsLabel} is not a clients/1 registry`);
  }
  const routes = [];
  for (const name of Object.keys(registry.clients).sort()) {
    const client = registry.clients[name];
    if (!client || typeof client !== 'object') continue;
    assertSafeId(name, 'a clients registry name');
    const models = Array.isArray(client.models)
      ? client.models.map(m => assertSafeId(m, `a models list entry of client ${name}`))
      : [];
    routes.push({
      id: name,
      available: client.present === true,
      models,
      basis: 'clients/1 registry: present + models list',
      budgetRemainingUsd: null
    });
  }
  if (routesData) {
    if (!routesData || !Array.isArray(routesData.routes)) throw new CorruptError(`corrupt: ${routesLabel} holds no routes array`);
    return routesData.routes.map(r => {
      if (!r || typeof r !== 'object' || typeof r.id !== 'string' || !r.id) throw new CorruptError(`corrupt: ${routesLabel} holds a route without an id`);
      assertSafeId(r.id, 'an operator route id');
      if (r.available !== undefined && r.available !== null && typeof r.available !== 'boolean') {
        throw new CorruptError(`corrupt: ${routesLabel} holds a route whose availability is neither true, false nor null`);
      }
      if (r.budgetRemainingUsd !== undefined && r.budgetRemainingUsd !== null && typeof r.budgetRemainingUsd !== 'number') {
        throw new CorruptError(`corrupt: ${routesLabel} holds a route whose budgetRemainingUsd is neither a number nor null`);
      }
      const models = r.models === undefined || r.models === null
        ? undefined
        : Array.isArray(r.models) ? r.models.map(m => assertSafeId(m, 'an operator route models entry')) : null;
      if (r.models !== undefined && r.models !== null && models === null) {
        throw new CorruptError(`corrupt: ${routesLabel} holds a route whose models list is not an array`);
      }
      return {
        id: r.id,
        available: typeof r.available === 'boolean' ? r.available : null,
        models,
        basis: 'operator routes file',
        budgetRemainingUsd: r.budgetRemainingUsd === undefined ? null : r.budgetRemainingUsd
      };
    });
  }
  return routes;
}

function evidenceFromLaunches(rootReal, launchesRel) {
  const launchesDir = pathSafe.realInside(rootReal, launchesRel);
  if (!launchesDir.ok) throw new CorruptError(`corrupt: the launches directory is refused by the path guard (${launchesDir.reason})`);
  const files = [];
  if (launchesDir.exists && launchesDir.type !== 'dir') throw new CorruptError('corrupt: the launches path is not a directory');
  if (launchesDir.exists) {
    const journal = path.join(launchesDir.real, 'LAUNCHES.jsonl');
    const jg = pathSafe.realInside(rootReal, journal);
    if (!jg.ok) throw new CorruptError(`corrupt: LAUNCHES.jsonl is refused by the path guard (${jg.reason})`);
    if (jg.exists && jg.type !== 'file') throw new CorruptError('corrupt: LAUNCHES.jsonl is not a regular file');
    if (jg.exists) files.push({ path: jg.real, label: 'LAUNCHES.jsonl' });
    const pendingDir = path.join(launchesDir.real, 'pending');
    const pg = pathSafe.realInside(rootReal, pendingDir);
    if (!pg.ok) throw new CorruptError(`corrupt: the pending launches path is refused by the path guard (${pg.reason})`);
    if (pg.exists) {
      if (pg.type !== 'dir') throw new CorruptError('corrupt: the pending launches path is not a directory');
      let names = [];
      try { names = fs.readdirSync(pg.real).filter(n => n.endsWith('.jsonl')).sort(); } catch { /* no evidence from an unreadable dir */ }
      for (const n of names) {
        assertSafeId(n, 'a pending launch file name');
        const g = pathSafe.realInside(rootReal, path.join(pg.real, n));
        if (!g.ok) throw new CorruptError(`corrupt: a pending launch file is refused by the path guard (${g.reason})`);
        if (g.exists && g.type !== 'file') throw new CorruptError('corrupt: a pending launch file is not a regular file');
        if (g.exists) files.push({ path: g.real, label: `pending/${n}` });
      }
    }
  }

  const evidence = [];
  for (const file of files) {
    const text = decodeStrict(fs.readFileSync(file.path), file.label);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { throw new CorruptError(`corrupt: ${file.label} holds a line that is not JSON`); }
      if (!rec || typeof rec !== 'object' || rec.schema !== 'launch-record/1' || rec.event) continue;
      const client = rec.tuple && typeof rec.tuple.client === 'string' ? rec.tuple.client : null;
      const requested = rec.tuple && typeof rec.tuple.model === 'string' ? rec.tuple.model : null;
      if (!client || !requested) continue;
      assertSafeId(client, 'a launch record client');
      assertSafeId(requested, 'a launch record requested model');
      if (typeof rec.servedModel !== 'string' || !rec.servedModel) continue;
      assertSafeId(rec.servedModel, 'a launch record served model');
      const launchId = typeof rec.launchId === 'string' && rec.launchId ? assertSafeId(rec.launchId, 'a launch record launchId') : null;
      // Every row is kept, mismatch rows included: a contradiction is data, not noise.
      evidence.push({
        transport: client,
        requested,
        servedModel: rec.servedModel,
        source: typeof rec.servedModelSource === 'string' ? rec.servedModelSource : 'none',
        confidence: typeof rec.servedModelConfidence === 'string' ? rec.servedModelConfidence : 'none',
        match: rec.servedModelMatch,
        launchId
      });
    }
  }
  return evidence;
}

// Evidence rows attach only to the models they are about (subject identity by modelsMatch); the
// pure function filters again per seat, so a wrong attachment cannot open eligibility.
function attachEvidence(models, evidence) {
  for (const model of models) {
    model.servedModelEvidence = evidence.filter(e => routeModelsMatch(e.transport, model.id, e.requested) === true || routeModelsMatch(e.transport, model.id, e.servedModel) === true);
  }
}

function readConstraints(realPath, label) {
  const data = readJson(realPath, label);
  if (!data || data.schema !== 'certifier-constraints/1' || !Array.isArray(data.excludedMakers)) {
    throw new CorruptError(`corrupt: ${label} is not a certifier-constraints/1 file with an excludedMakers array`);
  }
  for (const row of data.excludedMakers) {
    if (!row || typeof row !== 'object' || typeof row.maker !== 'string' || !row.maker.trim()) {
      throw new CorruptError(`corrupt: ${label} holds a row without a maker string`);
    }
    // a maker is a company name, as in the selection layer: the prose check, not the identifier grammar
    assertSafeProse(row.maker, 'a constraints maker name');
    if (typeof row.basis !== 'string' || !row.basis.trim()) {
      throw new CorruptError(`corrupt: ${label} holds a row without a basis; a row without a stated reason is refused`);
    }
    assertSafeProse(row.basis, 'a constraints basis');
  }
  return data;
}

function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node docs/ops/certifier-select.cjs --root REPO --author MODEL-ID [--author-transport CLIENT] [options]\n'); return 0; }
  const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
  const root = arg('root');
  if (!root || !fs.existsSync(root)) { process.stderr.write('unusable: --root <repo> is required and must exist\n'); return 2; }
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(root);
    if (!fs.statSync(rootReal).isDirectory()) rootReal = null;
  } catch { rootReal = null; }
  if (!rootReal) { process.stderr.write('unusable: --root is not a real existing directory\n'); return 2; }

  const identity = (modelArg, transportArg) => {
    if (modelArg === null || modelArg === undefined) return null;
    const model = assertSafeId(modelArg, 'a candidate identity argument');
    const transport = transportArg ? assertSafeId(transportArg, 'a candidate transport argument') : null;
    return { model, transport };
  };
  let author;
  try { author = identity(arg('author'), arg('author-transport', null)); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  if (!author) { process.stderr.write('unusable: --author <modelId> is required\n'); return 2; }
  const riskClass = arg('class', 'A');
  if (riskClass !== 'A' && riskClass !== 'B') { process.stderr.write('unusable: --class must be A or B\n'); return 2; }
  let fixer = null;
  let operator = null;
  try {
    fixer = identity(arg('fixer'), arg('fixer-transport', null));
    operator = identity(arg('operator'), arg('operator-transport', null));
  } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }

  // The layer lives in the development tree under its research folder; an installed product keeps the same folder under docs/product/launch-records.
  // The development folder wins when its layer file is there, so one root never mixes the two.
  const layerHomes = [path.join('docs', 'research', '2026-09-30-benchmark-catalog'), path.join('docs', 'product', 'launch-records')];
  const layerRel = layerHomes.find(home => fs.existsSync(path.join(rootReal, home, 'data', 'model-classes.json')))
    || (fs.existsSync(path.join(rootReal, layerHomes[1])) ? layerHomes[1] : layerHomes[0]);
  const layerFileRel = path.join(layerRel, 'data', 'model-classes.json');
  const clientsFileRel = path.join('.ai', 'docs', 'clients.json');
  const launchesRel = path.join(layerRel, 'launches');
  const routesArg = arg('routes');
  const constraintsArg = arg('constraints', path.join('docs', 'ops', 'certifier-constraints.json'));

  const layerReal = guardFileUnder(rootReal, layerFileRel, 'the selection layer file');
  const clientsReal = guardFileUnder(rootReal, clientsFileRel, 'the clients registry');
  const routesReal = routesArg ? guardOperatorFile(routesArg) : null;
  const constraintsReal = path.isAbsolute(constraintsArg) || constraintsArg.includes('..') || /^[A-Za-z]:[\\/]/.test(constraintsArg)
    ? guardOperatorFile(constraintsArg)
    : guardFileUnder(rootReal, constraintsArg, 'the constraints file');

  const models = layerFromModelClasses(readJson(layerReal, 'the selection layer file'), 'the selection layer file');
  const routes = routesFromClients(
    readJson(clientsReal, 'the clients registry'),
    routesReal ? readJson(routesReal, 'the operator routes file') : null,
    'the clients registry', 'the operator routes file');
  const evidence = evidenceFromLaunches(rootReal, launchesRel);
  attachEvidence(models, evidence);
  const constraints = readConstraints(constraintsReal, 'the constraints file');

  const input = {
    candidate: { author, fixer, operator },
    riskClass,
    layer: { models, routes },
    constraints
  };
  const result = selectCertifiers(input);

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  const seat = s => `${s.model} @ ${s.transport}`;
  process.stdout.write([
    `Recommendation (shadow, dispatch ${result.dispatch}); class ${result.riskClass}; score dimensions ${result.scoreDimensions.join(', ')}`,
    `Eligible seats (ordered): ${result.ordered.length === 0 ? 'none' : ''}`
  ].concat(result.ordered.map(s => `  ${seat(s)} score=${s.score} budgetRemainingUsd=${s.budgetRemainingUsd} evidence=${s.evidence.source}/${s.evidence.confidence}`))
    .concat([`Pairs (class A): ${result.pairs.length === 0 ? 'none' : ''}`])
    .concat(result.pairs.map(p => `  ${seat(p.first)} + ${seat(p.second)} score=${p.score}`))
    .concat(['Exclusions:'])
    .concat(result.excluded.map(e => `  ${e.model}${e.transport ? ' @ ' + e.transport : ''}: ${e.reason} (${e.detail})`))
    .concat(result.pairExcluded.map(p => `  pair ${seat(p.first)} + ${seat(p.second)}: ${p.reason}`))
    .join('\n') + '\n');
  return 0;
}

if (require.main === module) {
  let status;
  try { status = run(process.argv.slice(2)); }
  catch (e) {
    const message = (e && (e.corrupt || e.domain)) ? e.message : 'error: (an unexpected error; the message is not printed because it may hold unsafe values)';
    process.stderr.write(`${message}\n`);
    status = 2;
  }
  process.exit(status);
}

module.exports = { selectCertifiers, seatScore, seatOrder, pairOrder, seatEvidence, routeIndex, DEFAULT_SCORE_DIMENSIONS, PROOF_SOURCES, PROOF_CONFIDENCE };
