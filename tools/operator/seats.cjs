'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const S = require('./state.cjs');
const paths = require('../../.ai/bin/lib/path-safe.cjs');
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const { maskMarkdown } = require('../../.ai/bin/lib/text-safe.cjs');
const servedTool = require('../../docs/ops/served-model.cjs');
const CLIENTS = ['codex', 'claude', 'vibe', 'mimo', 'agy', 'kilo'];
const ROLES = ['author', 'reviewer', 'certifier', 'fixer'];
// One model identity grammar for every independence decision (classic pair and
// auto pair both end in validatePair). A model is the same model through any
// transport: the folded route model, its tail after the last provider slash
// and the id the closed alias data gives it are one identity. A declared family
// label is a separate claim and never substitutes for it.
const { canonicalModel, canonicalFamily, lineageFamily, lineageHeldModels, lineageRefusal, declaredFamily, dash } = require('../../.ai/bin/lib/model-identity.cjs');
const CHECK_LINEAGE_MODELS = true;
const DRAFT_ROUTE = Symbol('unfilled-draft-route');
function modelKeys(route) {
  return new Set([canonicalModel(route.model)]);
}
function validateContract(c, mode) {
  S.keys(c, ['id','stream','branch','sha','previousSha','mustMove','worktree','report','role','identity','family','route','instructions','sealed','lineage','riskClass'], ['id','stream','branch','sha','worktree','report','role','identity','family','route','instructions','sealed','lineage']);
  c.id = S.id(S.seatKey(c.id));
  c.worktree = S.seatKey(c.worktree, true);
  c.report = S.seatKey(c.report, true);
  for (const k of ['id','stream','identity','family']) S.id(c[k]);
  S.branch(c.branch); S.sha(c.sha);
  if (c.previousSha !== undefined) S.sha(c.previousSha);
  if (c.mustMove !== undefined && typeof c.mustMove !== 'boolean') S.fail('invalid-contract');
  if (c.mustMove && (!c.previousSha || c.previousSha === c.sha)) S.fail('unchanged-tip');
  if (!ROLES.includes(c.role) || typeof c.sealed !== 'boolean' || (c.role === 'certifier' && !c.sealed)) S.fail('invalid-role');
  if (typeof c.instructions !== 'string' || !c.instructions.trim() || c.instructions.length > 40000 || /[\u0000\u202a-\u202e\u2066-\u2069]/.test(c.instructions)) S.fail('invalid-instructions');
  S.inputText(c);
  for (const k of ['worktree','report']) if (typeof c[k] !== 'string' || path.isAbsolute(c[k]) || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(c[k]) || c[k].split('/').some(x => !x || x === '.' || x === '..')) S.fail('unsafe-path');
  if (!/^docs\/reviews\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/.test(c.report)) S.fail('invalid-report-path');
  S.keys(c.route, ['client','model','transport','executable','entry','effort'], ['client','model','transport','executable']);
  const r = c.route;
  if (require('../../.ai/bin/protocol-hooks.cjs').findSecretLeak(JSON.stringify(c))) S.fail('secret-in-contract');
  if (!CLIENTS.includes(r.client) || typeof r.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(r.model)) S.fail('explicit-route-required');
  S.id(r.transport);
  if (typeof r.executable !== 'string' || !path.isAbsolute(r.executable) || /\.(?:cmd|bat|ps1|sh)$/i.test(r.executable)) S.fail('native-client-required');
  if (r.entry !== undefined && (typeof r.entry !== 'string' || !path.isAbsolute(r.entry) || !/\.(?:cjs|mjs|js)$/.test(r.entry))) S.fail('invalid-client-entry');
  if (r.effort !== undefined && !/^[a-z][a-z0-9-]{0,24}$/.test(r.effort)) S.fail('invalid-effort');
  // Explicit reviewer-role exclusions and the measured Vibe alias trap.
  if (['reviewer','certifier'].includes(c.role) && (c.family === 'mistral' || /mistral/i.test(r.model))) S.fail('mistral-review-forbidden');
  if (r.client === 'vibe' && r.model !== 'glm-5-3') S.fail('vibe-alias-required');
  S.keys(c.lineage, ['author','operator','fixers','preReviewers','families'], ['author','operator','fixers','preReviewers']);
  if (c.riskClass !== undefined && !['A','B'].includes(c.riskClass)) S.fail('invalid-contract');
  S.id(c.lineage.author); S.id(c.lineage.operator);
  for (const k of ['fixers','preReviewers']) { if (!Array.isArray(c.lineage[k])) S.fail('invalid-lineage'); c.lineage[k].forEach(S.id); }
  // An explicit family is the only way a lineage entry names a family: an
  // opaque actor id is an exact identity, never a family prefix.
  if (c.lineage.families !== undefined) {
    if (!Array.isArray(c.lineage.families) || c.lineage.families.length > 8) S.fail('invalid-lineage');
    if (c.lineage.families.some(v => declaredFamily(v) === 'UNKNOWN')) S.fail('unknown-family');
  }
  if (c.sealed) {
    const excluded = [c.lineage.author,c.lineage.operator,...c.lineage.fixers,...c.lineage.preReviewers];
    // The route's own model identity is checked against the lineage too: a
    // free-form family label cannot move a sealed seat off the model that
    // authored, fixed or operated the candidate.
    if (excluded.includes(c.identity) || excluded.includes(c.family) || c.role !== 'certifier') S.fail('non-independent-seat');
    const ownModel = canonicalModel(r.model);
    if (mode !== DRAFT_ROUTE) {
    if (ownModel === 'UNKNOWN') S.fail('unknown-model-identity');
    // PILOT-FIX rounds 6 and 7 (J1, J7): every lineage token is read as the SET of known models it holds (any position, no boundary,
    // separator-free forms after the session suffix strip). A set that holds the certifier's own model, or for Class A any model of its
    // family, is refused by name; a token that holds no known model is an opaque session id; any other set is accepted.
    const refusals = excluded.map(token => lineageRefusal(token, ownModel, c.riskClass === 'A' ? canonicalFamily(r.model) : 'UNKNOWN'));
    // PILOT-FIX round 7 (J4, J5): a token outside the closed lineage grammar is refused first; the held set is read on separator-free forms.
    if (refusals.includes('lineage-token-outside-grammar')) S.fail('lineage-token-outside-grammar');
    if (refusals.includes('unknown-lineage-resembles-known-model')) S.fail('unknown-lineage-resembles-known-model');
    if (CHECK_LINEAGE_MODELS && refusals.includes('non-independent-seat')) S.fail('non-independent-seat');
    // PROTO-DEC-0186 item 3: for Class A the certifier's model family differs
    // from every author family. The author families are the declared ones plus
    // the family of every lineage entry that spells a known model; with none
    // established the rule cannot be proven and the seat is refused.
    if (c.riskClass === 'A') {
      const ownFamily = canonicalFamily(r.model);
      if (ownFamily === 'UNKNOWN') S.fail('unknown-family');
      const authors = new Set((c.lineage.families || []).map(declaredFamily));
      for (const token of excluded) { const family = lineageFamily(token); if (family !== 'UNKNOWN') authors.add(family); }
      // PILOT-FIX round 7 (J7): every model a lineage token holds contributes its family, so a two-model token counts for item 3.
      for (const token of excluded) for (const model of lineageHeldModels(token)) { const family = canonicalFamily(model); if (family !== 'UNKNOWN') authors.add(family); }
      if (!authors.size) S.fail('author-family-required');
      if (authors.has(ownFamily)) S.fail('family-not-independent');
    }
    }
  }
  return c;
}
// A route-less assignment draft has no model identity yet. Shape validation
// never authorizes execution; fillContract/runSeat/validatePair recheck it.
const validateDraftContract = c => validateContract(c, DRAFT_ROUTE);
function validatePair(p, workspace = process.cwd()) {
  S.keys(p, ['id','stream','branch','sha','seats'], ['id','stream','branch','sha','seats']);
  S.id(p.id); S.id(p.stream); S.branch(p.branch); S.sha(p.sha);
  if (!Array.isArray(p.seats) || ![1,2,3,4].includes(p.seats.length)) S.fail('invalid-pair-size');
  p.seats.forEach(validateContract);
  for (const c of p.seats) if (!c.sealed || c.stream !== p.stream || c.branch !== p.branch || c.sha !== p.sha || JSON.stringify(c.lineage) !== JSON.stringify(p.seats[0].lineage) || c.riskClass !== p.seats[0].riskClass) S.fail('pair-candidate-mismatch');
  for (const field of ['id','identity','family','worktree']) if (new Set(p.seats.map(c => c[field])).size !== p.seats.length) S.fail('non-independent-pair');
  const worktrees = p.seats.map(c => path.resolve(workspace,c.worktree));
  if (worktrees.some((a,i) => worktrees.slice(i+1).some(b => paths.sameFileOrNested(a,b)))) S.fail('non-independent-pair');
  if (new Set(p.seats.map(c => c.route.transport)).size !== p.seats.length) S.fail('duplicate-transport');
  if (p.seats.filter(S.isMiMoContract).length > 1) S.fail('mimo-busy');
  // The same model on two transports is one reviewer, not a pair.
  const identities = p.seats.map(c => modelKeys(c.route));
  if (identities.some((a, i) => identities.slice(i + 1).some(b => [...a].some(key => b.has(key))))) S.fail('non-independent-pair');
  return p;
}
function invocation(c, prompt, worktree) {
  validateContract(c);
  const r = c.route;
  const pointer = `Read and execute the UTF-8 task file ${prompt}. Targeted tests only. End the report with Verdict: PASS, FAIL, BLOCKED or RECOMMENDATION.`;
  if (/[\r\n]/.test(pointer)) S.fail('multiline-argv');
  let args;
  switch (r.client) {
    case 'codex': args = ['exec','-m',r.model,'--approve-for-me','-C',worktree,pointer]; break;
    case 'claude': args = ['-p',pointer,'--model',r.model,'--output-format','json']; break;
    case 'vibe': args = ['-p',pointer,'--auto-approve','--trust','--max-turns','200','--output','streaming','--workdir',worktree]; break;
    case 'mimo': args = ['run',pointer,'--model',r.model,'--yolo','--format','json']; break;
    case 'agy': args = ['-p',pointer,'--model',r.model,'--output-format','json']; break;
    case 'kilo': args = ['run','--auto','--model',r.model,pointer]; break;
    default: S.fail('explicit-route-required');
  }
  if (r.effort) {
    const { effortArgs } = require('../../.ai/bin/protocol-dispatch/clients.cjs');
    const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');
    const eff = effortArgs(r.client, r.effort, loadRegistry());
    if (eff.error) S.fail('invalid-effort');
    args.push(...(eff.args || []));
  }
  return { command: r.executable, args: [...(r.entry ? [r.entry] : []), ...args], cwd: worktree,
    env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1', ...(r.client === 'vibe' ? { VIBE_ACTIVE_MODEL: 'glm-5-3' } : {}) } };
}
function promptFor(c, runId) {
  return `# Operator contract ${c.id}\n\nRun: ${runId}\nCandidate: ${c.sha}\nRole: ${c.role}\nReport: ${c.report}\n\n${c.instructions}\n\nWrite your report only to the exact report path above.\nRequired own header lines:\nMode: ${c.sealed ? 'CERTIFYING' : 'AUTHOR'}\nReviewed-SHA: ${c.sha}\nRun: ${runId}\nStatus: FINAL\nReceipt-Owner: <actual protocol session owner>\n\nNever read another seat's report. Never publish, fetch, delete, or run a full suite.\nUse your own session journal and protocol-handoff record last.\nLast report line must be Verdict: PASS, FAIL, BLOCKED or RECOMMENDATION.\n`;
}
const {parseRegistry,REGISTRY_HEADER,REGISTRY_RULE,ACTIVE_STATUSES}=require('../../.ai/bin/lib/candidate-registry.cjs');
function registryDocument(ctx) {
  const file = 'candidates.md';
  const text = fs.existsSync(ctx.stateRoot) && fs.existsSync(ctx.guard(ctx.stateRoot,file))
    ? ctx.read(ctx.stateRoot,file) : '# Operator candidates\n\n' + REGISTRY_HEADER + '\n' + REGISTRY_RULE + '\n';
  // The shared reader validates text and paths, but can normalise BOM/CRLF.
  // Refuse that conversion here: even inactive Markdown must keep its bytes.
  if (fs.existsSync(ctx.stateRoot) && fs.existsSync(ctx.guard(ctx.stateRoot,file)) &&
      !fs.readFileSync(ctx.guard(ctx.stateRoot,file)).equals(Buffer.from(text,'utf8'))) S.fail('invalid-registry');
  return parseRegistry(text);
}
// Whole-tree compare of the registry before and after a synchronization: the
// strict parser re-reads the exact bytes about to be written. Every old row
// survives with identical cells except an active row of this stream that
// became superseded, and the stream ends with exactly one active row.
function verifySync(before, after, stream) {
  const key = cells => (cells || []).join('|'), live = cells => cells[0] === stream && ACTIVE_STATUSES.includes(cells[4]);
  if (after.rows.length !== before.length + 1) S.fail('invalid-registry');
  const kept = after.rows.slice(0, -1);
  if (!before.every((old, i) => key(old.cells) === key(kept[i]?.cells) || (live(old.cells) && key(old.cells.with(4, 'superseded')) === key(kept[i]?.cells)))) S.fail('invalid-registry');
  if (after.rows.filter(row => live(row.cells)).length !== 1) S.fail('invalid-registry');
}
function syncRegistry(ctx, c) {
  validateContract(c);
  const {lines,rows,tableEnd} = registryDocument(ctx);
  if (!fs.existsSync(ctx.stateRoot)) S.mkdir(path.dirname(ctx.stateRoot),path.basename(ctx.stateRoot));
  const target=ctx.guard(ctx.stateRoot,'candidates.md');
  const expected=fs.existsSync(target)?Buffer.from(lines.join('\n'),'utf8'):null;
  for (const {index,cells} of rows) {
    if (cells[0] === c.stream && ACTIVE_STATUSES.includes(cells[4])) {
      const parts = lines[index].split('|');
      parts[5] = parts[5].replace(cells[4], 'superseded');
      lines[index] = parts.join('|');
    }
  }
  const row = `| ${c.stream} | ${c.branch} | ${c.sha} | ${c.identity} | ${c.sealed ? 'certifying' : 'building'} | ${new Date().toISOString()} | operator-kit |`;
  const insertion = tableEnd;
  lines.splice(insertion,0,row);
  const next = lines.join('\n'), written = next + (next.endsWith('\n') ? '' : '\n');
  verifySync(rows, parseRegistry(written), c.stream);
  S.write(ctx.stateRoot,'candidates.md',written,expected);
}
function ownHeader(contents, key) {
  const values = maskMarkdown(contents).lines.filter(l => !l.masked && !l.partial && l.text.startsWith(`${key}: `)).map(l => l.text.slice(key.length + 2));
  return values.length === 1 ? values[0] : null;
}
function reportStatus(ctx, seat) {
  const c = seat.contract;
  const out = { seat: c.id, verdict: null, lines: null, done: false, running: false, reason: 'unknown' };
  try {
    validateContract(c); S.id(seat.runId);
    const runningFile = `${seat.runId}.running.json`;
    const terminalFile = `${seat.runId}.terminal.json`;
    const hasTerminal = fs.existsSync(ctx.guard(ctx.stateRoot,terminalFile));
    const running = fs.existsSync(ctx.guard(ctx.stateRoot,runningFile)) ? ctx.json(ctx.stateRoot,runningFile) : null;
    if (!hasTerminal) { out.running = Boolean(running && running.name === seat.runId && !running.ended); out.reason = out.running ? 'running' : 'no-terminal'; return out; }
    const t = ctx.json(ctx.stateRoot,terminalFile);
    if (!Number.isFinite(Date.parse(seat.startedAt))) { out.reason = 'invalid-start-time'; return out; }
    if (t.name !== seat.runId || t.owner !== c.identity || t.stream !== (seat.wrapperStream || c.stream) || !Number.isFinite(Date.parse(t.startedAt)) || Date.parse(t.startedAt) < Date.parse(seat.startedAt) || !Number.isFinite(Date.parse(t.endedAt)) || Date.parse(t.endedAt) < Date.parse(t.startedAt)) { out.reason = 'marker-mismatch'; return out; }
    if (running && (!running.ended || running.name !== t.name || running.startedAt !== t.startedAt)) { out.reason = 'running-marker-conflict'; out.running = true; return out; }
    out.done = true;
    if (t.status !== 'DONE' || t.exitCode !== 0 || t.signal || seat.exitCode !== 0) { out.reason = 'client-failed'; return out; }
    if (!seat.served || seat.served.match !== true) { out.reason = 'model-unproven'; return out; }
    const wt = ctx.guard(ctx.workspace,seat.worktree || c.worktree);
    const report = ctx.guard(wt,c.report);
    const content = ctx.read(wt,c.report);
    out.lines = content.split('\n').length - 1;
    if (fs.statSync(report).mtimeMs < Date.parse(seat.startedAt)) { out.reason = 'stale-report'; return out; }
    if (ownHeader(content,'Reviewed-SHA') !== c.sha || ownHeader(content,'Run') !== seat.runId || ownHeader(content,'Mode') !== (c.sealed ? 'CERTIFYING' : 'AUTHOR') || ownHeader(content,'Status') !== 'FINAL' || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(ownHeader(content,'Receipt-Owner') || '')) { out.reason = 'report-identity'; return out; }
    if (maskMarkdown(content).lines.some(l => !l.masked && !l.partial && /^(?:Status: )?(?:IN PROGRESS|PROVISIONAL)$/.test(l.text))) { out.reason = 'unfinished-report'; return out; }
    const v = readVerdict(content);
    if (!['closing','both'].includes(v.source)) { out.reason = 'no-final-verdict'; return out; }
    out.verdict = v.token; out.reason = v.reason;
    return out;
  } catch { out.reason = 'unreadable-or-invalid'; return out; }
}
function checkWorktree(ctx,c,wt) {
  if (!fs.existsSync(wt)) return;
  const common = cwd => fs.realpathSync(ctx.git(['rev-parse','--path-format=absolute','--git-common-dir'],cwd));
  if (common(wt) !== common(ctx.repo)) S.fail('foreign-worktree');
  if (ctx.git(['rev-parse','--show-toplevel'],wt).replace(/\\/g,'/') !== wt.replace(/\\/g,'/') || ctx.git(['rev-parse','HEAD'],wt) !== c.sha || ctx.git(['status','--porcelain'],wt)) S.fail('worktree-not-exact-clean');
  if (['author','fixer'].includes(c.role) && ctx.git(['symbolic-ref','--short','HEAD'],wt) !== c.branch) S.fail('author-branch-mismatch');
}
function reportInCommit(ctx, c) {
  return ctx.git(['ls-tree','-r','--name-only',c.sha,'--','docs/reviews']).split('\n').filter(Boolean)
    .some(file => S.seatKey(file,true) === S.seatKey(c.report,true));
}
function preflightLaunch(ctx, c, dryRun = false) {
  validateContract(c);
  if (ctx.git(['rev-parse','--verify',`refs/heads/${c.branch}^{commit}`]) !== c.sha) S.fail('stale-candidate');
  const wt = ctx.guard(ctx.workspace,c.worktree);
  if (wt === ctx.repo) S.fail('author-checkout-forbidden');
  checkWorktree(ctx,c,wt);
  const state = ctx.load();
  if (state.seats[c.id]) S.fail('seat-id-already-used');
  if (dryRun) return { seat: c.id, plan: 'seat', sha: c.sha };
  // The deterministic launch refusals run BEFORE the operator transaction
  // creates its lock, so a refused seat leaves no lock and no tombstone in
  // the state root (Codex O01, round 7). The in-lock re-checks stay
  // authoritative for everything that can change concurrently. A worktree
  // that does not exist yet cannot hold the report file, but the commit it
  // will check out can: the report path is read from that tree, so even a
  // fresh worktree refuses before anything is created.
  if (fs.existsSync(wt)) { if (fs.existsSync(ctx.guard(wt,c.report))) S.fail('report-already-exists'); }
  else if (reportInCommit(ctx,c)) S.fail('report-already-exists');
  if (Object.values(state.seats).some(x => paths.sameFileOrNested(ctx.guard(ctx.workspace,S.seatKey(x.worktree,true)),wt) && !reportStatus(ctx,x).done)) S.fail('seat-already-active');
  preflightRegistry(ctx);
  preflightNative(c);
  invocation(c, path.join(wt, '.ai/runtime/opkit-preflight.md'), wt);
  return { wt };
}
function preflightNative(c) {
  for (const file of [c.route.executable, c.route.entry].filter(Boolean)) {
    const real = S.guard(path.parse(file).root,file);
    if (!fs.existsSync(real) || !fs.statSync(real).isFile()) S.fail('invalid-client-file');
    try { fs.accessSync(real,file === c.route.executable ? fs.constants.X_OK : fs.constants.R_OK); }
    catch { S.fail('invalid-client-file'); }
  }
}
function preflightRegistry(ctx) {
  registryDocument(ctx);
}
async function runSeat(ctx, c, dryRun = false, pairRun = null, assignMeta = null) {
  const preflight = preflightLaunch(ctx, c, dryRun);
  if (dryRun) return preflight;
  if (!S.launchLocksHeld(ctx)) return S.acquireAll(ctx, {contracts:[c],pair:pairRun}, locked => runSeat(locked,c,false,pairRun,assignMeta));
  const { wt } = preflight;
  const wrapperStream = pairRun ? `pair-${S.hash(c.stream + ':' + c.id).slice(0,24)}` : c.stream;
  const perform = () => ctx.transaction(`stream-${S.hash(wrapperStream).slice(0,20)}`, async () => {
    // Validate again under the stream lock before any claim or worktree mutation.
    preflightLaunch(ctx, c);
    if (!fs.existsSync(wt)) ctx.git(['worktree','add',...(['author','fixer'].includes(c.role)?[wt,c.branch]:['--detach',wt,c.sha])]);
    checkWorktree(ctx,c,wt);
    const runId = `s-${crypto.randomUUID()}`;
    const promptRel = `.ai/runtime/opkit-${runId}.md`;
    const report = ctx.guard(wt,c.report);
    if (fs.existsSync(report)) S.fail('report-already-exists');
    const prompt = promptFor(c,runId);
    ctx.write(wt,promptRel,prompt);
    const startedAt = new Date().toISOString();
    // The assign metadata key exists only for a seat launched from an
    // assignment: a classic seat record keeps the base shape, no null key
    // (MiMo F-C).
    const record = { contract:c,runId,startedAt,endedAt:null,status:'starting',exitCode:null,served:null,worktree:c.worktree,report:c.report,stream:c.stream,wrapperStream,...(assignMeta?{assign:{...assignMeta}}:{}) };
    await ctx.transaction('registry',async () => {
      const s = ctx.load();
      if (s.seats[c.id] || Object.values(s.seats).some(x => x.worktree === c.worktree && !reportStatus(ctx,x).done)) S.fail('seat-already-active');
      syncRegistry(ctx,{...c,stream:wrapperStream});
      s.seats[c.id] = record; s.candidates[c.stream] = { stream:c.stream,branch:c.branch,sha:c.sha,status:c.sealed?'certifying':'building' }; ctx.save(s);
    });
    const input = `${runId}.input.json`;
    ctx.write(ctx.stateRoot,input,{ contract:c,worktree:wt,prompt:path.join(wt,promptRel),runId,startedAt });
    const wrapper = path.join(__dirname,'../../docs/ops/launch-wrapper.cjs');
    const runner = path.join(__dirname,'run-client.cjs');
    const args = [wrapper,'run','--name',runId,'--stream',wrapperStream,'--owner',c.identity,'--worktree',wt,'--repo',ctx.repo,'--runtime',ctx.stateRoot,'--registry',path.join(ctx.stateRoot,'candidates.md'),'--claims',path.join(ctx.stateRoot,`${runId}.claims.json`),'--pin-files',path.join(wt,promptRel),'--client',c.route.client,'--model',c.route.model,'--role',c.role,...(c.sealed?['--certifier']:[]),'--',process.execPath,runner,ctx.stateRoot,input];
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath,args,{ cwd:ctx.repo,env:{...process.env,PROTOCOL_NO_FULL_SUITE:'1'},windowsHide:true,stdio:['ignore','ignore','ignore'] });
      child.once('error',()=>resolve(null)); child.once('exit',(code,signal)=>resolve(signal?null:code));
    });
    await ctx.transaction('registry',async () => {
      const s = ctx.load(); const seat = s.seats[c.id];
      seat.exitCode = code; seat.endedAt = new Date().toISOString(); seat.status = code===0?'finished':'failed';
      const result = `${runId}.client.json`;
      if (fs.existsSync(ctx.guard(ctx.stateRoot,result))) { const r=ctx.json(ctx.stateRoot,result); if (r.runId===runId) seat.served=r.served; }
      ctx.save(s);
    });
    const result = reportStatus(ctx,ctx.load().seats[c.id]);
    // A seat launched from an assignment appends its outcome to the assignment
    // feedback log even when it failed: a silent catch would lose the line.
    if (assignMeta) require('./assign-bridge.cjs').recordSeatOutcome(ctx,ctx.load().seats[c.id],result,assignMeta);
    if (!result.done || !result.verdict) S.fail(result.reason || 'no-verdict');
    return result;
  });
  const launch = ()=>S.isMiMoContract(c) ? ctx.mimoTransaction(perform) : perform();
  return pairRun ? launch() : ctx.transaction('operator',launch);
}
async function runPair(ctx,p,dryRun=false,assignMetas=null) {
  validatePair(p,ctx.workspace);
  for (const c of p.seats) await runSeat(ctx,c,true);
  if (dryRun) return { pair:p.id,seats:p.seats.length };
  if (!dryRun) for (const c of p.seats) preflightLaunch(ctx, c);
  // The pair identity refusal runs before the operator transaction creates
  // its lock: a refused pair leaves no tombstone in the state root (round 7).
  if (ctx.load().pairs[p.id]) S.fail('pair-id-already-used');
  if (!S.launchLocksHeld(ctx)) return S.acquireAll(ctx, {contracts:p.seats,pair:p.id}, locked => runPair(locked,p,false,assignMetas));
  return ctx.transaction('operator',async()=>{
    for (const c of p.seats) preflightLaunch(ctx, c);
    const s=ctx.load(); if(s.pairs[p.id]) S.fail('pair-id-already-used');
    s.pairs[p.id]={...p,seats:p.seats.map(c=>c.id),status:'open'}; ctx.save(s);
    ctx.write(ctx.stateRoot,`watch-${p.id}.json`,{seats:p.seats.map(c=>c.id)});
    // One owning operation, simultaneous isolated seats, separate wrapper claims.
    const results=await Promise.all(p.seats.map(async (c,i)=>{try{return await runSeat(ctx,c,false,p.id,assignMetas?assignMetas[i]:null);}catch(e){return {seat:c.id,reason:e.code||'seat-failed'};}}));
    return {pair:p.id,results};
  });
}
function acceptPair(ctx,pairId) {
  const s=ctx.load(),p=s.pairs[pairId];
  if(!p || p.seats.length<2) S.fail('sealed-pair-required');
  const seats=p.seats.map(id=>s.seats[id]);
  if(seats.some(x=>!x)) S.fail('missing-seat');
  validatePair({id:p.id,stream:p.stream,branch:p.branch,sha:p.sha,seats:seats.map(x=>x.contract)});
  return seats.map(seat=>{
    const r=reportStatus(ctx,seat),c=seat.contract;
    if(!r.done || !['PASS','RECOMMENDATION'].includes(r.verdict)) S.fail('unaccepted-verdict');
    const wt=ctx.guard(ctx.workspace,c.worktree),content=ctx.read(wt,c.report),owner=ownHeader(content,'Receipt-Owner');
    // A textual verdict is insufficient: the independent session must own a current receipt.
    const {spawnSync}=require('node:child_process');
    const v=spawnSync(process.execPath,[path.join(wt,'.ai/bin/protocol-handoff.cjs'),'verify','--owner',owner],{cwd:wt,env:{...process.env,PROTOCOL_NO_FULL_SUITE:'1'},windowsHide:true,stdio:'ignore'});
    if(v.status!==0 || !ctx.read(wt,`.ai/worklog/${owner}.md`).includes(c.report)) S.fail('receipt-unverified');
    return {seat:c.id,worktree:c.worktree,report:c.report,sha:c.sha,verdict:r.verdict,transport:c.route.transport};
  });
}
module.exports={registryDocument,parseRegistry,verifySync,modelKeys,validateContract,validateDraftContract,validatePair,invocation,promptFor,syncRegistry,ownHeader,reportStatus,runSeat,runPair,acceptPair,checkWorktree,preflightRegistry,preflightNative,reportInCommit,CLIENTS,ROLES};
