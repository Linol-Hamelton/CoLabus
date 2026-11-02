'use strict';
// Read adapters only: registry grammar, wrapper markers and the stage-1 normalization gate.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const registry = require('../../.ai/bin/lib/candidate-registry.cjs');
const { buildLaunchRecord } = require('../../.ai/bin/launch-record.cjs');
const ledger = require('./ledger.cjs');
const reader = require('./reader.cjs');
function branchTip(repo, branch) {
  // This is the package's only subprocess: literal read-only git argv, never a shell.
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', branch===null ? 'HEAD' : `refs/heads/${branch}^{commit}`], { encoding:'utf8', timeout:10000, windowsHide:true });
  if(!result.error && result.status===1 && branch!==null)return {state:'missing'};
  if (result.error || result.status !== 0 || !/^[a-f0-9]{40}\s*$/.test(result.stdout || '')) return {state:'unavailable',reason:'branch-tip-unavailable'};
  return result.stdout.trim();
}
function candidates(file) {
  let parsed;
  try { parsed = registry.parseRegistry(reader.readText(file, 'registry')); }
  catch (e) { reader.refuse(e.code?.startsWith('registry-') ? e.code : 'registry-invalid'); }
  const landed = new Set(parsed.rows.filter(r => r.cells[4] === 'landed').map(r => r.cells[0]));
  const rows = parsed.rows.filter(r => registry.ACTIVE_STATUSES.includes(r.cells[4]) && !landed.has(r.cells[0])).map(({ cells }) => {
    const [stream, branch, sha, owner, status, updated] = cells;
    return { stream, branch, sha, owner, status, updated };
  });
  if (new Set(rows.map(r => r.stream)).size !== rows.length) reader.refuse('registry-duplicate-active');
  return rows;
}
function history(file) {
  const loaded = ledger.readLaunches(file);
  if (loaded.refusal) reader.refuse(/REFUSED records-(?:invalid|empty):/.test(loaded.refusal) ? 'ledger-no-valid-records' : 'ledger-unreadable');
  const recs = loaded.valid;
  const byId = new Map(recs.map(r => [r.id, r]));
  // End times are intentionally obtained through normalized start + proven wall; unknown stays absent.
  // Preserve individual observations: the plan filters future times BEFORE taking any maximum.
  const activity = recs.flatMap(r => r.startedMs === null ? [] : [r.startedMs, ...(r.ended && r.wallSeconds !== null ? [r.startedMs + r.wallSeconds * 1000] : [])]);
  return { recs, invalid:loaded.invalid.count, byId, activity };
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // Same liveness predicate as launch-wrapper; signal zero only, no process stop capability.
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// Only an attributed metadata header is authoritative; prompt/body text and seat-name guesses are not.
function affiliation(directory, marker, launch) {
  let call = null;
  const file = path.join(directory, `${marker.name}-call.txt`);
  if (fs.existsSync(file)) {
    const bytes=reader.bytes(file,'call');
    for (const line of bytes.toString('utf8').split(/\r?\n/).filter(line=>line.startsWith('CYCLE_CALL '))) {
      let current;
      try { current = require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(line.slice(11)); }
      catch { reader.refuse('call-metadata'); }
      if(!current || typeof current!=='object' || Array.isArray(current) || typeof current.client!=='string' || !/^[a-z][a-z0-9-]{0,63}$/.test(current.client) ||
        !['author','certifier','pre-review','unknown'].includes(current.role))reader.refuse('call-metadata');
      if (current.name === marker.name && current.startedAt === marker.startedAt && call===null) call = current;
    }
  }
  const known=value=>typeof value==='string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) && !/^unknown(?:-client|-role)?$/.test(value);
  const client = [launch?.client,call?.client,marker.resolver?.operator?.client].find(known) || 'unknown-client';
  const role = [launch?.role,call?.role].find(known) || 'unknown-role';
  return { client, role };
}
// The one marker reader: null when absent, the validated marker, or a refusal.
function marker(directory,name,kind) {
  const file=path.join(directory,`${name}.${kind}.json`),what=kind==='terminal'?'terminal':'seat';
  try { fs.lstatSync(file); }
  catch (e) { if (e.code !== 'ENOENT') reader.refuse('terminal-unreadable'); return null; }
  const value=require('./input-shapes.cjs').marker(reader.json(file,what),kind);
  if(value.name!==name)reader.refuse(`${what}-schema`);
  return value;
}
function markerPair(directory,name) {
  const r=marker(directory,name,'running'),t=marker(directory,name,'terminal');
  const sameLaunch=Boolean(r && t && t.startedAt===r.startedAt);
  return {running:r,terminal:t,sameLaunch};
}
function running(directory, historyData, now, probe = alive) {
  const safe = require('../../.ai/bin/lib/path-safe.cjs');
  const guard = safe.realInside(path.parse(path.resolve(directory)).root, path.resolve(directory), { allowRoot:true });
  if (!guard.ok || !guard.exists || guard.type !== 'dir') reader.refuse('seats-directory');
  const seats = [], inactive = [];
  for (const name of fs.readdirSync(directory).filter(n => n.endsWith('.running.json')).sort()) {
    const pair=markerPair(directory,name.slice(0,-13)),r=pair.running;
    if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.name !== 'string' || name !== `${r.name}.running.json`) reader.refuse('seat-schema');
    if (r.ended) { inactive.push({ name:r.name, reason:'ended' }); continue; }
    const sameLaunch=pair.sameLaunch;
    if(sameLaunch) {inactive.push({ name:r.name, reason:'terminal' }); continue;}
    const live = probe(r.childPid) || probe(r.wrapperPid);
    if (!live) { inactive.push({ name:r.name, reason:'process-gone' }); continue; }
    if (typeof r.startedAt !== 'string' || ledger.isoProblem(r.startedAt) || Date.parse(r.startedAt) > now || typeof r.stream !== 'string') reader.refuse('seat-time-or-stream');
    // Same identity constructor as cert-launch; never infer an association from a record's nonexistent name.
    const id = buildLaunchRecord({ name:r.name, startedAt:r.startedAt, endedAt:r.startedAt }).launchId;
    const launch = historyData.byId.get(id);
    const { client, role } = affiliation(directory, r, launch);
    seats.push({ name:r.name, stream:r.stream, client, role, startedAt:r.startedAt, startedMs:Date.parse(r.startedAt), tokens:launch?.tokens?.total ?? null,
      worktree:r.worktree || null, runtime:directory, clientLog:r.clientLog || path.join(directory,`${r.name}.client.jsonl`) });
  }
  return { seats, inactive };
}
module.exports = { branchTip, candidates, history, running, alive, affiliation, marker, markerPair };
