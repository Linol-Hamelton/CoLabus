'use strict';
// Local diagnostics are not report data. Scan every emitted value with the
// protocol's existing credential detector; never publish a matched value.
const { findSecretLeak } = require('../../.ai/bin/protocol-hooks.cjs');

function safeLine(value) {
  const s = String(value);
  if (findSecretLeak(s)) return 'REDACTED sensitive diagnostic';
  // A diagnostic cannot distinguish spaces/punctuation in a path from trailing
  // prose. Redact through the end of that physical line, including the basename.
  // Do this before escaping controls so multiline diagnostics keep their bounds.
  return s.replace(/[A-Za-z]:[\\/][^\r\n]*/g, '[local-path]')
    .replace(/[\\/]{2}[^\r\n]*/g, '[local-path]')
    // Inspect the whole token at each slash, not just its last character.
    // A lone punctuation prefix is a boundary; named/glob segments are relative.
    .replace(/[^\r\n]+/g, line => {
      for (const match of line.matchAll(/[\p{L}\p{N}_.*@+=?\\/-]+/gu)) {
        const slash = match[0].indexOf('/');
        if (slash === -1) continue;
        const prefix = match[0].slice(0, slash);
        if (prefix.endsWith('=') || (!/[\p{L}\p{N}]/u.test(prefix) && prefix !== '..')) {
          return `${line.slice(0, match.index + prefix.length)}[local-path]`;
        }
      }
      return line;
    })
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
      ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

module.exports = { safeLine };
