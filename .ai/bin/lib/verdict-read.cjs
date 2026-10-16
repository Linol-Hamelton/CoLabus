'use strict';
const textSafe = require('./text-safe.cjs');

const TOKENS = ['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION'];
const TOKEN = `(${TOKENS.join('|')})`;
const KEYED = [`Verdict: ${TOKEN}`, `\\*\\*Verdict: ${TOKEN}\\*\\*`, `\\*\\*Verdict:\\*\\* ${TOKEN}`, `Overall: ${TOKEN}`, `\\*\\*Overall: ${TOKEN}\\*\\*`];
const LONE = [TOKEN, `\\*\\*${TOKEN}\\*\\*`];
const EXPLANATION = '(?:(?: - | -- | — |: | \\().*)?';
const form = list => new RegExp(`^(?:${list.join('|')})${EXPLANATION}$`);
//  item 2: the template header form, Source B only.
const TEMPLATE_HEADER = `\\*\\*Verdict\\*\\*: ${TOKEN}(?:[ \\t]+$)?`;
const CLOSING_LINE = form([...KEYED, ...LONE]);
const HEADER_LINE = form([...KEYED, TEMPLATE_HEADER]);
const MODE_LINE = /^(?:[-*] )?(?:Mode:|\*\*Mode:\*\*|\*\*Mode\*\*:)/;
const HEADER_LINES = 60;

const tokenOf = (re, s) => { const m = re.exec(s); return m ? m.slice(1).find(Boolean) : null; };
const result = (token, source, reason) => ({ token, source, reason });

function readVerdict(input) {
  let text;
  if (input instanceof Uint8Array) {
    const d = textSafe.decode(input, { bom: 'strip', crlf: 'normalise' });
    if (!d.ok) return result(null, null, 'undecodable');
    text = d.text;
  } else if (typeof input === 'string') {
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  } else return result(null, null, 'undecodable');

  const lines = textSafe.maskMarkdown(text).lines;
  const own = l => l && !l.masked && !l.partial;
  let last = lines.length - 1;
  while (last >= 0 && /^[ \t]*$/.test(lines[last].text)) last -= 1;
  const closing = last >= 0 && own(lines[last]) ? tokenOf(CLOSING_LINE, lines[last].text) : null;

  let header = null;
  const top = lines.slice(0, HEADER_LINES);
  if (top.some(l => own(l) && MODE_LINE.test(l.text))) {
    // The closing line itself is never also the header (one line is one source). A last line that is no closing
    // line (the template form is header-only) stays a header line.
    const found = new Set(top.filter((l, i) => own(l) && !(closing && i === last)).map(l => tokenOf(HEADER_LINE, l.text)).filter(Boolean));
    if (found.size > 1) return result(null, null, 'conflicting-sources');
    header = found.size ? [...found][0] : null;
  }
  if (closing && header) return closing === header ? result(closing, 'both', null) : result(null, null, 'conflicting-sources');
  if (closing) return result(closing, 'closing', null);
  if (header) return result(header, 'header', null);
  return result(null, null, 'no-closing-verdict-line');
}

module.exports = { readVerdict, TOKENS };
