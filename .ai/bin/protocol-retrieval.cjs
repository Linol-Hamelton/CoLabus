#!/usr/bin/env node
'use strict';
// Rules retrieval: the retriever of the seat packet.
// It scores the kernel records against the task text through a qmd daemon (a local search server over the kernel Markdown) and prints a result of the closed shape
// rules-retrieval/1 that the packet compiler applies (.ai/bin/protocol-packet.cjs --retrieval, checkRetrieval). The compiler never
// searches; this file never decides what a packet carries. When qmd cannot be reached, the result is `unavailable` with its reason,
// and the compiler keeps the full selection and says so in the packet.
//   node .ai/bin/protocol-retrieval.cjs --task FILE --role R --stage S [--url U] [--collection C] [--threshold T] [--cap N] [--timeout-ms MS] [--out FILE]
// Prints one JSON document (with --out FILE writes it there: the input of cert-launch/fix-launch --packet-retrieval and launch-packet --retrieval); exit 0 (an unreachable daemon is a result, not an error); exit 2 on unusable arguments.
// Defaults: score threshold 0.5 (the reranked qmd score, 0..1), cap 8 records. The daemon address (--url or QMD_URL) and the qmd
// collection that indexes .ai/core (--collection or QMD_COLLECTION) are settings of the project: this file carries no address and no
// collection name, and a missing one is an `unavailable` result that names it. The step is opt-in: the launchers apply a result only
// when --packet-retrieval names one; without it the packet is the one compiled without retrieval. Nothing here changes the machine.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');


const SCHEMA = 'rules-retrieval/1';
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_CAP = 8;
const DEFAULT_TIMEOUT_MS = 30000;
const QUERY_CHARS = 500; // the head of the task text that becomes the query: a 1200-character query crashed the daemon (CUDA error in the expansion model)
const RESULT_LIMIT = 40; // the rerank window; a record outside it is "not retrieved" and keeps a pointer line (never lost)
const REASON_SAFE = /[^A-Za-z0-9 ._:/()=,+-]/g;
const COLLECTION_NAME = /^[A-Za-z0-9._-]{1,64}$/;

const sha = text => crypto.createHash('sha256').update(text).digest('hex');
// The query: the role, the stage and the head of the task text with Markdown marks, links and fences folded to plain words.
function buildQuery(taskText, role, stage) {
  const plain = String(taskText).replace(/```[\s\S]*?```/g, ' ').replace(/[`*#>|_[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `role ${role}, stage ${stage}: ${plain}`.slice(0, QUERY_CHARS);
}
// The typed sub-queries sent to qmd: a BM25 line of the distinct words of the query (no qmd operator: no quote, no leading minus) and the
// query itself as the semantic line. Typed sub-queries skip the query-expansion model: the auto-expanded form crashed the daemon
// (CUDA error in llama.cpp); the reranked score stays the score the threshold reads.
function searchesOf(query) {
  const seen = new Set();
  const lex = [];
  for (const w of query.toLowerCase().split(/[^a-z0-9]+/)) if (w.length >= 4 && !seen.has(w) && lex.length < 24) { seen.add(w); lex.push(w); }
  return [{ type: 'lex', query: lex.join(' ') || 'rules' }, { type: 'vec', query }];
}
const safeReason = text => String(text).replace(REASON_SAFE, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown';
const unavailable = (querySha, threshold, cap, reason) => ({ schema: SCHEMA, source: 'unavailable', querySha, threshold, cap, scores: [], reason: safeReason(reason) });

// A qmd hit names a file relative to its collection (COLLECTION/L2-procedures/P-L2-004-acceptance.md); the record path is the same
// path under .ai/core. Hits outside the collection, outside the record grammar or twice (the best score wins) are left out.
function scoresOf(results, collection) {
  const best = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || typeof r.file !== 'string' || typeof r.score !== 'number' || !Number.isFinite(r.score)) continue;
    if (!r.file.startsWith(`${collection}/`)) continue;
    const rel = `.ai/core/${r.file.slice(collection.length + 1)}`;
    if (!/^\.ai\/core\/[A-Za-z0-9._/-]{1,200}\.md$/.test(rel) || rel.split('/').includes('..')) continue;
    const score = Math.min(1, Math.max(0, r.score));
    if (!best.has(rel) || best.get(rel) < score) best.set(rel, score);
  }
  return [...best].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([p, score]) => ({ path: p, score }));
}

// The qmd daemon speaks MCP over HTTP (JSON or one server-sent event); the result of the `query` tool is structuredContent.results.
function parseMcpBody(text) {
  const t = String(text).trim();
  const json = t.startsWith('{') ? t : (t.split('\n').find(l => l.startsWith('data: ')) || '').slice(6);
  if (!json) throw new Error('empty response');
  const msg = JSON.parse(json);
  if (msg.error) throw new Error(`mcp error ${msg.error.code}`);
  const sc = msg.result && msg.result.structuredContent;
  if (!sc || !Array.isArray(sc.results)) throw new Error('no structured results');
  if (msg.result.isError) throw new Error('tool error');
  return sc.results;
}

async function retrieve(opts, deps = {}) {
  const threshold = opts.threshold === undefined ? DEFAULT_THRESHOLD : opts.threshold;
  const cap = opts.cap === undefined ? DEFAULT_CAP : opts.cap;
  const collection = opts.collection;
  const query = buildQuery(opts.taskText, opts.role, opts.stage);
  const querySha = `sha256:${sha(query)}`;
  // the settings of the project: no address or no collection is a result that names the missing setting, never a guessed default
  // (a reason is one line of [A-Za-z0-9 ._:/()=,+-], so it names the argument, not the environment variable)
  if (!opts.url) return unavailable(querySha, threshold, cap, 'no qmd address: give --url');
  if (!collection || !COLLECTION_NAME.test(collection)) return unavailable(querySha, threshold, cap, 'no qmd collection: give --collection');
  const fetchImpl = deps.fetch || globalThis.fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(opts.url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'query', arguments: { searches: searchesOf(query), collections: [collection], limit: RESULT_LIMIT, candidateLimit: RESULT_LIMIT, intent: 'kernel records (rules, procedures, stop conditions) that apply to this task of an AI coding seat' } } }),
    });
    if (!res.ok) return unavailable(querySha, threshold, cap, `qmd http ${res.status}`);
    const scores = scoresOf(parseMcpBody(await res.text()), collection);
    return { schema: SCHEMA, source: 'qmd', querySha, threshold, cap, scores };
  } catch (error) {
    const code = error && (error.name === 'AbortError' ? 'timeout' : (error.cause && error.cause.code) || error.code || error.message);
    return unavailable(querySha, threshold, cap, `qmd unreachable: ${code}`);
  } finally { clearTimeout(timer); }
}

function parseArgs(argv) {
  const o = {};
  const valued = new Set(['--task', '--role', '--stage', '--url', '--collection', '--threshold', '--cap', '--timeout-ms', '--out']);
  for (let i = 0; i < argv.length; i++) {
    if (!valued.has(argv[i]) || i + 1 >= argv.length) return { error: `unknown or incomplete argument ${argv[i]}` };
    const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(o, key)) return { error: `${argv[i]} is given twice` };
    o[key] = argv[++i];
  }
  if (!o.task || !o.role || !o.stage) return { error: 'usage: protocol-retrieval.cjs --task FILE --role R --stage S [--url U] [--collection C] [--threshold T] [--cap N] [--timeout-ms MS] [--out FILE]' };
  if (o.threshold !== undefined) { if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(o.threshold)) return { error: '--threshold is a number from 0 to 1' }; o.threshold = Number(o.threshold); }
  if (o.cap !== undefined) { if (!/^[1-9][0-9]?$/.test(o.cap) || Number(o.cap) > 64) return { error: '--cap is an integer from 1 to 64' }; o.cap = Number(o.cap); }
  if (o.timeoutMs !== undefined) { if (!/^[1-9][0-9]{2,5}$/.test(o.timeoutMs)) return { error: '--timeout-ms is an integer from 100 to 999999' }; o.timeoutMs = Number(o.timeoutMs); }
  return o;
}

async function main(argv, deps = {}) {
  const o = parseArgs(argv);
  if (o.error) { process.stderr.write(`${o.error}\n`); return 2; }
  let taskText;
  try { taskText = fs.readFileSync(path.resolve(o.task), 'utf8'); } catch (error) { process.stderr.write(`task file ${o.task} is not readable (${error.code || 'error'})\n`); return 2; }
  const result = await retrieve({ ...o, taskText, url: o.url || process.env.QMD_URL, collection: o.collection || process.env.QMD_COLLECTION }, deps);
  if (o.out) fs.writeFileSync(path.resolve(o.out), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  process.stderr.write(`RETRIEVAL source=${result.source} scores=${result.scores.length} threshold=${result.threshold} cap=${result.cap}${result.reason ? ` reason=${JSON.stringify(result.reason)}` : ''}\n`);
  return 0;
}

module.exports = { SCHEMA, DEFAULT_THRESHOLD, DEFAULT_CAP, QUERY_CHARS, buildQuery, searchesOf, scoresOf, parseMcpBody, retrieve, parseArgs, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
