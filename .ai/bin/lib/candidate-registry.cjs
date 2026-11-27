'use strict';
const {decode,maskMarkdown}=require('./text-safe.cjs');
const {parseOwnerIdentity}=require('./owner-identity.cjs');
const CHECK_ORPHANS = true;
const S={fail(code,reason,index){const fields=reason ? {reason,line:index+1} : {};throw Object.assign(Error(code),{code,...fields});},
  id(v){if(typeof v!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(v))this.fail('invalid-registry');},
  owner(v){
    parseOwnerIdentity(v);
  },
  sha(v){if(!/^[a-f0-9]{40}$/.test(v))this.fail('invalid-registry');},
  branch(v){if(!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(v)||v.includes('..')||v.endsWith('.lock')||v.endsWith('/')||v.includes('//'))this.fail('invalid-registry');}};
const REGISTRY_STATUSES = ['building','ready','certifying','certified','landed','retired','void','superseded'];
const ACTIVE_STATUSES = ['building','ready','certifying','certified'];
const REGISTRY_UPDATED = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function validDate(value) {
  if(!REGISTRY_UPDATED.test(value))return false;
  const date=value.slice(0,10),at=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(at)&&new Date(at).toISOString().slice(0,10)===date
    && (value.length===10 || Number.isFinite(Date.parse(value)));
}
// The table is a closed data grammar. Markdown constructs INSIDE a cell do not
// open a block or span, and cannot change membership of subsequent rows.
function pipeCells(line) {
  const value = line.trim();
  if (!value.startsWith('|') || !value.endsWith('|')) return null;
  const cells = value.split('|').slice(1,-1).map(v=>v.trim());
  return cells.length === 7 ? cells : null;
}
function parseRegistry(input) {
  if(typeof input!=='string'&&!Buffer.isBuffer(input))S.fail('invalid-registry');
  if(typeof input==='string'&&!input.isWellFormed())S.fail('invalid-registry');
  const decoded=decode(Buffer.isBuffer(input)?input:Buffer.from(input,'utf8'),{bom:'refuse',crlf:'refuse',invisible:'refuse',finalNewline:'refuse'});
  if(!decoded.ok||decoded.notes.some(n=>n.code==='NOT_NFC'))S.fail('invalid-registry');
  const text=decoded.text;
  const lines = text.split('\n'), rows = [];
  // Keep Markdown masking at the document boundary only. Clearing all possible
  // seven-cell rows also prevents orphan cell text from hiding the real heading;
  // fences/comments/HTML opened OUTSIDE rows remain in this structural view.
  const masked = maskMarkdown(lines.map(line => pipeCells(line) ? '' : line).join('\n')).lines;
  const own = line => !line.masked && !line.partial;
  const sections = masked.filter(line => own(line) && /^# (?:Operator candidates|Registry)[ \t]*$/.test(line.text));
  if (sections.length !== 1) S.fail('invalid-registry');
  const start = sections[0].line;
  let header = 0, rule = 0, tableStart = -1, tableEnd = start;
  // The final empty split item is the required LF, not an extra blank line.
  for (let index = start; index < lines.length - 1; index++) {
    const line = lines[index], mark = masked[index];
    if (own(mark) && /^#{1,6}[ \t]/.test(line)) break;
    const cells = pipeCells(line);
    if (!header) {
      if (!line.trim()) continue;
      // Prose before the table is allowed, but a data block is never a header.
      if (mark.kinds.includes('list-item')) break;
      if (!cells || !own(mark)) continue;
      if (cells.join('|') !== 'stream|branch|sha|owner|status|updated|note') S.fail('invalid-registry', 'invalid-header', index);
      header = 1;
      tableStart = index;
    } else if (!rule) {
      if (!cells || !cells.every(v=>/^:?-{3,}:?$/.test(v))) S.fail('invalid-registry', 'invalid-rule', index);
      rule = 1;
    } else {
      if (!cells) S.fail('invalid-registry', 'table-interrupted', index);
      let valid = cells.every(Boolean);
      try { S.id(cells[0]); S.branch(cells[1]); S.sha(cells[2]); S.owner(cells[3]); S.id(cells[4]); }
      catch (error) {
        if (['INVALID_OWNER','INVALID_MACHINE','MACHINE_CONFLICT'].includes(error.code)) S.fail('invalid-registry', error.code, index);
        valid = false;
      }
      valid = valid && REGISTRY_STATUSES.includes(cells[4]) && validDate(cells[5]);
      if (!valid) S.fail('invalid-registry', 'invalid-row', index);
      rows.push({index,cells});
    }
    tableEnd = index + 1;
  }
  if (header !== 1 || rule !== 1) S.fail('invalid-registry');
  if (CHECK_ORPHANS) for (let index=0;index<lines.length;index++) {
    // Even a masked seven-cell row outside the selected table is ambiguous.
    if (index >= tableStart && index < tableEnd) continue;
    if (pipeCells(lines[index])) S.fail('invalid-registry', 'orphan-row', index);
  }
  return { lines, rows, tableEnd };
}

// One writer at a time over a registry file: a tool that reads the table, changes rows and replaces the file holds this lock from the
// read to the replacement, so two such tools never replace each other's rows. The lock is a file `FILE.lock` made in one step while the
// name is free; it is released when the action ends. A waiting tool tries again for `waitMs`. A lock is the leftover of a tool that ended
// without releasing, and is taken over, only when the process it names is proven gone; a live writer keeps it however long its action
// runs. A lock that names no process at all (its writer ended between making the name and writing its pid) is taken over once it is
// older than `staleMs`. The action runs once.
function lockOwnerGone(lock, staleMs) {
  const fs = require('node:fs');
  const pid = Number((/^(\d+)\s/.exec(fs.readFileSync(lock, 'utf8')) || [])[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - fs.statSync(lock).mtimeMs > staleMs;
  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function withRegistryLock(file, action, { waitMs = 15000, staleMs = 60000, pauseMs = 25 } = {}) {
  const fs = require('node:fs');
  const lock = `${file}.lock`;
  const started = Date.now();
  for (;;) {
    let fd = null;
    try { fd = fs.openSync(lock, 'wx'); } catch (error) {
      if (!['EEXIST', 'EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      try { if (lockOwnerGone(lock, staleMs)) fs.unlinkSync(lock); } catch { /* released meanwhile */ }
      if (Date.now() - started >= waitMs) throw Object.assign(Error('REGISTRY-BUSY'), { code: 'REGISTRY-BUSY' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pauseMs);
      continue;
    }
    try {
      try { fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } catch { /* the name alone holds the lock */ }
      return action();
    } finally {
      fs.closeSync(fd);
      try { fs.unlinkSync(lock); } catch { /* already gone */ }
    }
  }
}

// Headings that earlier skeletons wrote and the grammar no longer accepts, each named whole. An upgrade replaces exactly that
// one line with the current heading and keeps every other byte; any other registry that fails the grammar is refused with
// the fix, never rewritten.
const LEGACY_HEADINGS = Object.freeze(['# Реестр кандидатов проекта (пустой каркас pilot-install)']);
const CURRENT_HEADING = '# Operator candidates';
const HEADING_FIX = `the registry needs exactly one heading line "${CURRENT_HEADING}" (or "# Registry") above the table "| stream | branch | sha | owner | status | updated | note |" with its rule line; see docs/ops/CANDIDATES-TEMPLATE.md`;
function migrateHeading(input) {
  const valid = bytes => { try { parseRegistry(bytes); return null; } catch (error) { return error.reason || error.code || 'invalid-registry'; } };
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  const first = valid(bytes);
  if (first === null) return { action: 'valid' };
  const text = bytes.toString('utf8');
  const lines = text.split('\n');
  const at = lines.findIndex(line => LEGACY_HEADINGS.includes(line));
  if (at < 0 || lines.filter(line => LEGACY_HEADINGS.includes(line)).length !== 1) return { action: 'refused', reason: first, fix: HEADING_FIX };
  const next = Buffer.from([...lines.slice(0, at), CURRENT_HEADING, ...lines.slice(at + 1)].join('\n'), 'utf8');
  const after = valid(next);
  if (after !== null) return { action: 'refused', reason: after, fix: HEADING_FIX };
  return { action: 'migrated', bytes: next, line: at + 1, from: lines[at], to: CURRENT_HEADING };
}

module.exports={parseRegistry,withRegistryLock,migrateHeading,LEGACY_HEADINGS,REGISTRY_HEADER:"| stream | branch | sha | owner | status | updated | note |",REGISTRY_RULE:"|---|---|---|---|---|---|---|",REGISTRY_STATUSES,ACTIVE_STATUSES};
