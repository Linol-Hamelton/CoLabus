'use strict';
// A small pool around the synchronous governed probe. Workers return only its closed result.
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const probe = require('./probe.cjs');
const LIMIT = 3;
const CLIENT_CAPS = Object.freeze({ kilo: 2, cline: 1, mimo: 1, vibe: 1, codex: 1, claude: 1, kimi: 1 });
function keys(route) {
  const model = route.model || '';
  const group = /sub2api-gpt/.test(route.id) || /^(?:openai-compatible\/)?gpt-/.test(model) && ['kilo', 'cline'].includes(route.client) ? 'sub2api-gpt'
    : /sub2api-gemini/.test(route.id) || /^(?:openai-compatible\/)?gemini-/.test(model) && ['kilo', 'cline'].includes(route.client) ? 'sub2api-gemini'
      : route.billing === 'free' ? 'free' : /deepseek/.test(model) ? 'deepseek' : `${route.client}:${model}`;
  return [`client:${route.client}`, `group:${group}`, `identity:${route.client}:${model}`, `route:${route.id}`];
}
function cap(key) {
  if (key.startsWith('client:')) return CLIENT_CAPS[key.slice(7)] || 1;
  return key === 'group:free' ? 2 : 1;
}
function runWorker(route, options) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { route, options }, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
    let result;
    worker.once('message', message => { result = message; });
    worker.once('error', () => reject(new Error('PROBE_WORKER_FAILED')));
    // A message is not completion: keep the lease until the worker exits.
    worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error('PROBE_WORKER_FAILED')));
  });
}
async function runBatch(routes, options = {}, deps = {}) {
  const pending = routes.map((route, i) => ({ route, i }));
  const active = new Map(), results = new Array(routes.length), used = new Map();
  const run = deps.run || runWorker;
  while (pending.length || active.size) {
    let i = 0;
    while (i < pending.length && active.size < LIMIT) {
      const item = pending[i], resources = keys(item.route);
      if (resources.some(k => (used.get(k) || 0) >= cap(k))) { i++; continue; }
      pending.splice(i, 1);
      resources.forEach(k => used.set(k, (used.get(k) || 0) + 1));
      // A scarce route is launch-only: it never reaches a worker, whatever the caller selected.
      const task = Promise.resolve().then(() => (probe.isScarce(item.route.client) ? { skipped: 'SCARCE_LIMIT' } : run(item.route, options))).then(
        value => ({ item, resources, value }), () => ({ item, resources, error: true }));
      active.set(item.i, task);
    }
    const done = await Promise.race(active.values());
    active.delete(done.item.i);
    done.resources.forEach(k => used.set(k, used.get(k) - 1));
    results[done.item.i] = done.error ? { ok: false, reason: 'SPAWN_FAILED', at: new Date(options.nowMs ?? Date.now()).toISOString() } : done.value;
  }
  return results;
}
if (!isMainThread && workerData) parentPort.postMessage(probe.runProbe(workerData.route, workerData.options));
module.exports = { LIMIT, CLIENT_CAPS, keys, runBatch, runWorker };
