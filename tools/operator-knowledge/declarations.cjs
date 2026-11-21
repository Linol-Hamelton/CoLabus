'use strict';
// Read-only owner work queue. Commands reference unset owner inputs; no facts are invented.
const rs = require('./route-state.cjs');
function declarations(record, now) {
  const state = rs.stateAt(record, now);
  return record.routes.flatMap((route, i) => {
    const names = new Set([...route.requiredDeclared, ...rs.DECLARED_FIELDS.filter(n => route.fields[n])]);
    return [...names].sort().flatMap(field => {
      const view = state.routes[i].fields[field];
      if (view?.effective) return [];
      const reason = !view ? 'MISSING' : view.future ? 'FUTURE' : 'EXPIRED';
      return [{ route: route.id, field, reason,
        command: `node tools/operator-knowledge/declare.cjs --route ${route.id} --field ${field} --value "$OwnerValue" --by "$OwnerAct" --source "$OwnerProvenance"` }];
    });
  });
}
function main(argv) {
  try {
    const f = rs.parseFlags(argv, ['record', 'now', 'json'], ['json']);
    if (f._.length) throw new rs.Refusal('USAGE', 'unexpected argument');
    const file = f.record ? rs.resolvePathArg(f.record, 'record') : rs.RECORD_FILE;
    const rows = declarations(rs.loadRecord(file), f.now || new Date().toISOString());
    // A custom record must never yield a command targeting the production record.
    if (f.record) for (const row of rows) row.command += ` --record '${file.replace(/'/g, "''")}'`;
    if (f.json) process.stdout.write(`${JSON.stringify(rows)}\n`);
    else {
      process.stdout.write('Set OwnerValue, OwnerAct and OwnerProvenance from the owner word before each command. Never paste credentials.\n');
      for (const row of rows) process.stdout.write(`${row.route} ${row.field} ${row.reason}\n${row.command}\n`);
      process.stdout.write(`DECLARATIONS pending=${rows.length}\n`);
    }
    return 0;
  } catch (e) { process.stderr.write(`REFUSED ${e instanceof rs.Refusal ? e.code : 'DECLARATIONS_UNREADABLE'}\n`); return 4; }
}
module.exports = { declarations, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
