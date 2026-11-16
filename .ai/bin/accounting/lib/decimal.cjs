'use strict';
// Exact decimal arithmetic on BigInt (route price tools). A value is { n: BigInt, s: number }: n / 10^s, s >= 0.
// No JavaScript float ever touches a price: prices are parsed from their decimal text, shifted by powers of ten,
// compared, weighted and printed as decimal text. Division is only by an integer and rounds half up at a stated scale.

const NUM_RE = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse decimal text ("0.0000000079", "1e-7", "-1", "2.85"). Returns null for anything else.
 * A JavaScript number is NOT accepted: its text is the only exact source, so callers pass the source text.
 * @param {string} text
 * @returns {{n: bigint, s: number}|null}
 */
function parse(text) {
  if (typeof text !== 'string') return null;
  const m = NUM_RE.exec(text.trim());
  if (!m) return null;
  const frac = m[3] || '';
  let n = BigInt(m[2] + frac);
  let s = frac.length;
  const exp = m[4] ? Number(m[4]) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 60) return null;
  if (exp > 0) {
    if (exp >= s) { n *= 10n ** BigInt(exp - s); s = 0; } else s -= exp;
  } else s += -exp;
  if (m[1] === '-') n = -n;
  return norm({ n, s });
}

/** Drop trailing zeros of the fraction. */
function norm(d) {
  let { n, s } = d;
  while (s > 0 && n % 10n === 0n) { n /= 10n; s -= 1; }
  return { n, s };
}

/** Multiply by 10^k (k may be negative: the scale grows). */
function shift10(d, k) {
  if (k >= 0) {
    if (k >= d.s) return norm({ n: d.n * 10n ** BigInt(k - d.s), s: 0 });
    return norm({ n: d.n, s: d.s - k });
  }
  return norm({ n: d.n, s: d.s - k });
}

/** Price per token text -> price per million tokens as a decimal object. */
function perMillionFromPerToken(text) {
  const d = parse(text);
  return d ? shift10(d, 6) : null;
}

function align(a, b) {
  const s = Math.max(a.s, b.s);
  return [a.n * 10n ** BigInt(s - a.s), b.n * 10n ** BigInt(s - b.s), s];
}

function cmp(a, b) {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function add(a, b) {
  const [x, y, s] = align(a, b);
  return norm({ n: x + y, s });
}

function sub(a, b) {
  const [x, y, s] = align(a, b);
  return norm({ n: x - y, s });
}

/** Multiply by a non-negative integer (BigInt or safe integer). */
function mulInt(a, k) {
  return norm({ n: a.n * BigInt(k), s: a.s });
}

/** Round to at most `digits` fractional digits, half up (away from zero for a negative value). */
function round(a, digits) {
  if (a.s <= digits) return norm(a);
  const drop = 10n ** BigInt(a.s - digits);
  const neg = a.n < 0n;
  const abs = neg ? -a.n : a.n;
  let q = abs / drop;
  if ((abs % drop) * 2n >= drop) q += 1n;
  return norm({ n: neg ? -q : q, s: digits });
}

/** Divide by a positive integer, rounded half up to `digits` fractional digits. */
function divInt(a, k, digits) {
  const kk = BigInt(k);
  if (kk <= 0n) throw new Error('divisor must be positive');
  const scale = digits + 2;
  const num = a.n * 10n ** BigInt(scale);
  const den = kk * 10n ** BigInt(a.s);
  // exact quotient scaled by 10^scale, then rounded to `digits`
  const neg = num < 0n;
  const abs = neg ? -num : num;
  const q = abs / den;
  const r = abs % den;
  let qq = r * 2n >= den ? q + 1n : q;
  return round({ n: neg ? -qq : qq, s: scale }, digits);
}

/** Plain decimal text with no exponent and no trailing zeros ("0.0079", "2.85", "10"). */
function toString(a) {
  const d = norm(a);
  const neg = d.n < 0n;
  let digits = (neg ? -d.n : d.n).toString();
  if (d.s === 0) return (neg ? '-' : '') + digits;
  if (digits.length <= d.s) digits = '0'.repeat(d.s - digits.length + 1) + digits;
  const cut = digits.length - d.s;
  return `${neg ? '-' : ''}${digits.slice(0, cut)}.${digits.slice(cut)}`;
}

function isZero(a) { return a.n === 0n; }
function isNegative(a) { return a.n < 0n; }

/** Percent spread of max over min as text with `digits` decimals: (max - min) / min * 100. Null when min is zero. */
function spreadPercent(min, max, digits) {
  if (isZero(min)) return null;
  const diff = sub(max, min);
  // (diff * 100) / min: scale both to integers
  const [x, y] = align(diff, min);
  const scale = digits + 2;
  const q = (x * 100n * 10n ** BigInt(scale)) / y;
  const r = (x * 100n * 10n ** BigInt(scale)) % y;
  const qq = r * 2n >= y ? q + 1n : q;
  return toString(round({ n: qq, s: scale }, digits));
}

module.exports = { parse, norm, shift10, perMillionFromPerToken, cmp, add, sub, mulInt, round, divInt, toString, isZero, isNegative, spreadPercent };
