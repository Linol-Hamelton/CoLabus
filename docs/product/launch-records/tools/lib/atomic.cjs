'use strict';
// Atomic file write: temp file in the same directory, then rename ( section 1).
// A failed write or rename removes its own temp file before the error is rethrown, so a failure leaves no temp file behind.

const fs = require('fs');
const path = require('path');

/**
 * Write a file atomically. The directory is created when missing.
 * @param {string} file target path
 * @param {string|Buffer} content
 */
function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw e;
  }
}

module.exports = { writeFileAtomic };
