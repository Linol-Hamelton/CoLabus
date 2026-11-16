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

module.exports={parseRegistry,REGISTRY_HEADER:"| stream | branch | sha | owner | status | updated | note |",REGISTRY_RULE:"|---|---|---|---|---|---|---|",REGISTRY_STATUSES,ACTIVE_STATUSES};
