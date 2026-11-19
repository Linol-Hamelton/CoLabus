'use strict';
// One filename grammar for wrapper launches and their persisted identity.
const MAX_NAME_LENGTH = 64;
function launchNameProblem(name) {
  if (typeof name !== 'string' || !name) return '--name must not be empty';
  if (name.length > MAX_NAME_LENGTH) return `--name is longer than ${MAX_NAME_LENGTH} characters`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '--name may contain letters, digits, dot, dash and underscore only';
  if (name.startsWith('.')) return '--name must not start with a dot';
  if (name.endsWith('.')) return '--name must not end with a dot';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) return '--name must not be a reserved Windows device name (con, prn, aux, nul, com1-9, lpt1-9)';
  return null;
}
module.exports = { launchNameProblem, MAX_NAME_LENGTH };
