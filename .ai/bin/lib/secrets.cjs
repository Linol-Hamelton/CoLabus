'use strict';
// Shared output-boundary scan. Existing launch-record shapes plus the protocol
// journal assignment shapes; never return or echo the matched credential.
const PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i, /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/,
  /(?:SESSION_SECRET|ADMIN_TOKEN|API_KEY|AUTH_TOKEN|PRIVATE_KEY|SECRET_KEY|WEB_ONBOARD_[A-Z_]+)[ \t]*=[ \t]*['"][^'"]{8,}['"]/i,
  /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED|PRIVATE) KEY-----/,
  /\bglpat-[A-Za-z0-9-]{20}/, /\bsk_live_[0-9a-zA-Z]{24}/,
];
function secretIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return PATTERNS.some(pattern => pattern.test(text));
}
module.exports = { secretIn };
