'use strict';

// Shared metric CLI diagnostic; preserve coercion, one LF and exit code 2.
function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }

module.exports = { usage };
