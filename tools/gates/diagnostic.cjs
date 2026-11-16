'use strict';
// Local diagnostics are not report data. Scan every emitted value with the
// protocol's existing credential detector; never publish a matched value.
const { findSecretLeak } = require('../../.ai/bin/protocol-hooks.cjs');

function safeLine(value) {
  const s = String(value);
  if (findSecretLeak(s)) return 'REDACTED sensitive diagnostic';
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
    ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/[A-Za-z]:[\\/][^\s"<>)]*/g, p => '[local-path]/' + p.split(/[\\/]/).pop())
    .replace(/\/(?:Users|home)\/[^\s"<>)]*/g, p => '[local-path]/' + p.split('/').pop());
}

module.exports = { safeLine };
