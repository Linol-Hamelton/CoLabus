'use strict';
// Compatibility forwarding; implementation belongs to the installed kernel.
if (require.main === module) {
  const target = require.resolve('../../../../.ai/bin/accounting/launch-stats.cjs');
  process.argv[1] = target;
  require('node:module').runMain(target);
} else {
  module.exports = require('../../../../.ai/bin/accounting/launch-stats.cjs');
}
