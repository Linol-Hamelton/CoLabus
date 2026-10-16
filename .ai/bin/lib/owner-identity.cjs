'use strict';

const refuse = code => { throw Object.assign(new Error(code), { code }); };

function safeMachineId(raw) {
  // Absolute end, including refusal of a final newline (unlike RegExp `$`).
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?![\s\S])/.test(raw)) refuse('INVALID_MACHINE');
  const safe = raw.toLowerCase();
  if (['unknown','null','undefined'].includes(safe)) refuse('INVALID_MACHINE');
  return safe;
}

function parseOwnerIdentity(rawOwner, explicitMachine = null) {
  if (typeof rawOwner !== 'string') refuse('INVALID_OWNER');
  const pieces = rawOwner.split(/[/@]/);
  if (pieces.length > 2) refuse('INVALID_OWNER');
  let owner = pieces[0], machine = null;
  if (pieces.length === 2) {
    owner = rawOwner.includes('/') ? pieces[1] : pieces[0];
    machine = safeMachineId(rawOwner.includes('/') ? pieces[0] : pieces[1]);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?![\s\S])/.test(owner) || ['unknown','null','undefined'].includes(owner.toLowerCase())) refuse('INVALID_OWNER');
  if (explicitMachine !== null && explicitMachine !== undefined) {
    const explicit = safeMachineId(explicitMachine);
    if (machine !== null && machine !== explicit) refuse('MACHINE_CONFLICT');
    machine = explicit;
  }
  return { owner, machine, namespaced: machine === null ? owner : `${machine}/${owner}`, hasNamespace: machine !== null };
}

module.exports = { parseOwnerIdentity, safeMachineId };
