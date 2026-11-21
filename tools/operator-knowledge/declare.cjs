#!/usr/bin/env node
'use strict';
// declare.cjs - the ONLY writer of DECLARED route fields (guarantee K2).
//
//   node tools/operator-knowledge/declare.cjs --route ID --field NAME --value V \
//        --by "owner message YYYY-MM-DD" [--now ISO] [--days N] [--source TEXT] [--record FILE]
//
// It refuses, with a named reason and exit 4:
//   a measured field (probe, performance)       FIELD_MEASURED
//   an unknown route or field                   ROUTE_UNKNOWN / FIELD_UNKNOWN
//   a missing or malformed owner act            OWNER_ACT
//   a non-positive or too large --days          DAYS_INVALID
//   a blank or placeholder --source             SOURCE_INVALID
//   a declaration beyond the clock tolerance     DECLARED_AT_FUTURE
//   a record the one strict reader refuses      RECORD_* / SCHEMA_*
// A measured field is written only by refresh.cjs; this tool never opens it. The write is atomic
// (temp file in the same directory, then rename) and the success line prints the field and the
// expiry but never the value, so a secret pasted by mistake is not echoed.
// Updates go to the ignored durable sibling route-state.local.json; the tracked
// seed is unchanged, and the strict reader merges by field timestamp.

const rs = require('./route-state.cjs');

const ALLOWED = ['route', 'field', 'value', 'by', 'now', 'days', 'source', 'record', 'help'];
const USAGE = [
  'usage: node tools/operator-knowledge/declare.cjs --route ID --field NAME --value V --by "owner message DATE" [--now ISO] [--days N] [--source TEXT] [--record FILE]',
  'writes one DECLARED field (balance, limit, plan, price); measured fields are refused',
].join('\n');

function main(argv) {
  let flags;
  try {
    flags = rs.parseFlags(argv, ALLOWED, ['help']);
    if (flags.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    if (flags._.length) throw new rs.Refusal('USAGE', `unexpected argument ${flags._[0]}`);
    if (!flags.route) throw new rs.Refusal('USAGE', '--route is required');
    if (!flags.field) throw new rs.Refusal('USAGE', '--field is required');
    if (flags.value === undefined) throw new rs.Refusal('USAGE', '--value is required');
    if (!flags.by) throw new rs.Refusal('OWNER_ACT', 'a declared field must name the owner act in --by');
    const days = flags.days === undefined ? undefined : Number(flags.days);
    if (days !== undefined && (!/^\d+$/.test(flags.days) || !Number.isInteger(days))) throw new rs.Refusal('DAYS_INVALID', '--days must be a positive integer');
    const nowMs = flags.now === undefined ? undefined : rs.timeMs(flags.now, '--now');
    const recordFile = flags.record ? rs.resolvePathArg(flags.record, 'record') : rs.RECORD_FILE;
    // One writer at a time: the read, the change and the atomic write happen inside
    // the lock, so two declares cannot both write a record read before the other's change.
    const result = rs.withRecordLock(rs.localRecordFile(recordFile), () => {
      const record = rs.loadRecord(recordFile);
      const written = rs.setDeclared(record, flags.route, flags.field, {
        value: flags.value,
        declaredBy: flags.by,
        nowMs,
        days,
        // Only an ABSENT --source names the tool; an explicitly empty one is judged (SOURCE_INVALID).
        source: flags.source === undefined ? 'declare.cjs' : flags.source,
      });
      record.generatedAt = rs.isoOf(Date.now());
      rs.writeLocalRecord(record, recordFile);
      return written;
    });
    process.stdout.write(`DECLARED route=${flags.route} field=${result.field} by="${flags.by}" declaredAt=${result.declaredAt} expiresAt=${result.expiresAt}\n`);
    return 0;
  } catch (e) {
    if (e instanceof rs.Refusal) {
      process.stderr.write(`REFUSED ${e.code}: ${e.detail}\n`);
      return e.code === 'USAGE' ? 2 : 4;
    }
    process.stderr.write(`REFUSED INTERNAL: ${String(e && e.message ? e.message : e).slice(0, 200)}\n`);
    return 4;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
