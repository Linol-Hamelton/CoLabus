'use strict';

// Fake client for S4-T04 fixtures: prints one progress line every 100 ms for N seconds (argv[3] === 'silent': prints
// nothing), then exits 0 without writing any declared output. It always ends by itself, so a failed fixture leaves no process behind.
const seconds = Number(process.argv[2] || 9);
const silent = process.argv[3] === 'silent';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const end = Date.now() + seconds * 1000;
  let n = 0;
  while (Date.now() < end) {
    if (!silent) console.log(`PROGRESS line ${n++}`);
    await sleep(100);
  }
  process.exit(0);
})();
