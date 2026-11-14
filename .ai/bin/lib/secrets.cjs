'use strict';
// Shared output-boundary scan. Existing launch-record shapes plus the protocol
// journal assignment shapes; never return or echo the matched credential.
// Every pattern carries a fixed label: secretKind names the class that matched (the launcher refusal of a credential-shaped packet says which
// class stopped it) and never the matched text.
const RULES = [
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{16,}/], ['github-token', /\bghp_[A-Za-z0-9]{20,}/], ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/], ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/], ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i], ['private-key-block', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['named-credential-assignment', /\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*\S{6,}/],
  ['quoted-credential-assignment', /(?:SESSION_SECRET|ADMIN_TOKEN|API_KEY|AUTH_TOKEN|PRIVATE_KEY|SECRET_KEY|WEB_ONBOARD_[A-Z_]+)[ \t]*=[ \t]*['"][^'"]{8,}['"]/i],
  ['key-block', /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED|PRIVATE) KEY-----/],
  ['gitlab-token', /\bglpat-[A-Za-z0-9-]{20}/], ['stripe-live-key', /\bsk_live_[0-9a-zA-Z]{24}/],
];
const PATTERNS = RULES.map(([, pattern]) => pattern);
const textOf = value => (typeof value === 'string' ? value : JSON.stringify(value));
function secretIn(value) {
  const text = textOf(value);
  return PATTERNS.some(pattern => pattern.test(text));
}
// The label of the first rule that matches, else null; the matched text is never returned.
function secretKind(value) {
  const text = textOf(value);
  const hit = RULES.find(([, pattern]) => pattern.test(text));
  return hit ? hit[0] : null;
}
// RULES is the one list: a scanner with its own reading loop (a chunked file scan) takes these patterns, never a copy.
module.exports = { secretIn, secretKind, RULES };
