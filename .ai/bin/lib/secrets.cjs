'use strict';
// Shared output-boundary scan. Existing launch-record shapes plus the protocol
// journal assignment shapes; never return or echo the matched credential.
// Every pattern carries a fixed label: secretKind names the class that matched (the launcher refusal of a credential-shaped packet says which
// class stopped it) and never the matched text.
// A value that is already masked is not a credential. The closed list of masks: a run of asterisks, x, X, # or the bullet, or one of
// the words redacted, masked, hidden, removed in lower, upper or capital case, bare or inside a matching [] or <> pair. The exemption
// is strict and has no label or length carve-out: the whole remainder of the line after the assignment operator must be one mask,
// optionally inside one matching pair of quotes or brackets, then only blanks and at most one closing character (, ; ) ] } or a quote)
// up to the end of the line. Any other non-blank content after the mask on the same line is refused, whatever its length or wording.
// A line break ends the line: the next line is a new line and is judged alone.
const MASK_WORD = String.raw`(?:REDACTED|redacted|Redacted|MASKED|masked|Masked|HIDDEN|hidden|Hidden|REMOVED|removed|Removed)`;
const MASK_BARE = String.raw`(?:[*xX#•]+|\[${MASK_WORD}\]|<${MASK_WORD}>|${MASK_WORD})`;
const MASK_WRAPPED = String.raw`(?:"${MASK_BARE}"|'${MASK_BARE}'|\(${MASK_BARE}\)|\[${MASK_BARE}\]|\{${MASK_BARE}\}|<${MASK_BARE}>|${MASK_BARE})`;
const BLANK = String.raw`[^\S\r\n]`;
const MASK_LINE = String.raw`${MASK_WRAPPED}${BLANK}*(?:[,;)\]}'"]${BLANK}*)?(?=[\r\n]|$)`;
// A mask, also one opened and not closed, with anything else after it on its line: a short token, a label, a value.
const MASK_THEN_MORE = String.raw`["'(\[{<]?${MASK_BARE}${BLANK}*\S`;
const RULES = [
  // Keep both GitHub forms: the shared short alphanumeric token and the legacy substring form with underscores.
  ['openai-style-key', /\bsk-[A-Za-z0-9_-]{16,}/], ['github-token', /(?:\bghp_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9_]{36})/], ['github-pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['google-key', /\bAIza[0-9A-Za-z_-]{30,}/], ['slack-token', /xox[abprs]-[A-Za-z0-9-]{10,}/], ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/i], ['private-key-block', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['named-credential-assignment', new RegExp(String.raw`\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*(?:(?!${MASK_LINE})\S{6,}|(?!${MASK_LINE})${MASK_THEN_MORE})`)],
  ['quoted-credential-assignment', /(?:SESSION_SECRET|ADMIN_TOKEN|API_KEY|AUTH_TOKEN|PRIVATE_KEY|SECRET_KEY|WEB_ONBOARD_[A-Z_]+)[ \t]*=[ \t]*['"][^'"]{8,}['"]/i],
  ['key-block', /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED|PRIVATE) KEY-----/],
  // These legacy token forms match inside a word as well as at its boundary.
  ['gitlab-token', /glpat-[A-Za-z0-9-]{20}/], ['stripe-live-key', /sk_live_[0-9a-zA-Z]{24}/],
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
