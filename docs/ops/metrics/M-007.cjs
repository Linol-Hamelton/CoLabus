'use strict';
// Compatibility forwarding; implementation belongs to the installed kernel.
if (require.main === module) {
  const target = require.resolve('../../../.ai/bin/metrics/M-007.cjs');
  process.argv[1] = target;
  require('node:module').runMain(target);
} else {
  module.exports = require('../../../.ai/bin/metrics/M-007.cjs');
}
