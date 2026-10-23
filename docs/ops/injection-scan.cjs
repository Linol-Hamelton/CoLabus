#!/usr/bin/env node
'use strict';
// injection-scan.cjs - model-free prompt-injection scanner (PROTO-DEC-0132 item 4).
// Shared scanner exposed to the
// current architecture: a READ-ONLY ADVISORY checker. It never edits, marks or moves the scanned file, writes
// nothing, decides nothing; "a signal, not a defence" (0132 item 4). Wiring into launchers is a proposal only
// Shared rules are kept next to their implementation.
//
// Usage:
//   node docs/ops/injection-scan.cjs [--json] <file-or-directory>...
//   node docs/ops/injection-scan.cjs --rules
// Output (text mode): one line per hit `HIT <rule> <path>:<line> <excerpt>`, one line per input that could not be
// scanned `UNKNOWN <path> <reason>`, and a closing `RESULT exit=<n> files=<n> hits=<n> unknown=<n>` line.
// Exit: 0 every input scanned and no hit; 1 every input scanned and at least one hit; 2 bad invocation or at
// least one input UNKNOWN (unknown is never a pass). A hit is one (rule, line) pair.
//
// The rule set is CLOSED (8 rules, RULES below) and every rule is a POSITIVE grammar: what it matches is
// written out; nothing is excluded by a skip list. Text is data: the scanner reads it and never acts on it.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');

const MAX_BYTES = 16 * 1024 * 1024;
const EXCERPT_MAX = 72;

// ---------------------------------------------------------------- normalisation (the views the phrase rules read)
// Confusables: letters that look like a Latin letter fold to it. Step 1 is case-aware (an upper-case twin maps to
// upper case), then the text is lower-cased, then step 3 merges the lower-case Cyrillic letters whose upper-case
// form was a twin. The same fold is applied to the non-ASCII letters of a rule pattern, so a rule written in
// Cyrillic matches any Latin/Cyrillic/Greek mix that looks the same.
const CASE_MAP = new Map(Object.entries({
  'А': 'A', 'В': 'B', 'С': 'C', 'Е': 'E', 'Н': 'H', 'К': 'K', 'М': 'M', 'О': 'O', 'Р': 'P', 'Т': 'T', 'Х': 'X',
  'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S', 'Ԛ': 'Q', 'Ԝ': 'W', 'Һ': 'H', 'Ӏ': 'I',
  'а': 'a', 'с': 'c', 'е': 'e', 'о': 'o', 'р': 'p', 'х': 'x', 'у': 'y', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd',
  'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w',
  'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P',
  'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w',
  'ϲ': 'c', 'ı': 'i', 'ɡ': 'g', 'ɑ': 'a', 'ȷ': 'j',
}));
const LOWER_MERGE = new Map(Object.entries({ 'в': 'b', 'н': 'h', 'к': 'k', 'м': 'm', 'т': 't' }));
// Code points that are letters (category Lo/Mn) yet render as nothing: removed from the views and reported by
// the zero-width rule like the format characters.
const INVISIBLE_LETTERS = new Set([0x115f, 0x1160, 0x3164, 0xffa0, 0x034f]);
// Inline HTML elements join their neighbours; every other tag separates words.
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'code', 'del', 'em', 'font', 'i', 'ins', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'tt', 'u', 'var', 'wbr']);
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', zwj: '', zwnj: '',
  lrm: '', rlm: '', colon: ':', sol: '/', vert: '|', verbar: '|', lowbar: '_', hyphen: '-', dash: '-', period: '.',
  comma: ',', excl: '!', num: '#', dollar: '$', lpar: '(', rpar: ')', ast: '*', plus: '+', equals: '=', grave: '`',
  tilde: '~', bsol: '\\', semi: ';', quest: '?', commat: '@', lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', tab: ' ',
  newline: '\n' };
const MARKDOWN_JOINERS = new Set(['*', '`', '~', '\\']);

function foldChar(ch) {
  let out = '';
  for (const piece of ch.normalize('NFKD')) {
    if (/\p{M}/u.test(piece)) continue;
    const mapped = CASE_MAP.get(piece) || piece;
    for (const low of mapped.toLowerCase()) out += LOWER_MERGE.get(low) || low;
  }
  return out;
}

function foldPattern(source) {
  return source.replace(/[^\x00-\x7f]/g, ch => foldChar(ch));
}

function isInvisible(cp) {
  if (INVISIBLE_LETTERS.has(cp)) return true;
  const ch = String.fromCodePoint(cp);
  return /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}]/u.test(ch);
}

function isVariationSelector(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

// Builds the folded view of `raw`: line terminators become '\n', HTML tags (when stripTags) and comment markers
// are removed, character references are decoded, invisible code points and markdown joiners are dropped, a word
// broken by a hyphen at a line end is joined, every remaining character is folded. `lines[k]` is the raw line and
// `rawAt[k]` the raw index of view position k. Mutation switches exist only to let the tests prove each step.
function buildView(raw, { stripTags, mutate = new Set() }) {
  let text = '';
  const lines = [];
  const rawAt = [];
  let line = 1;
  const push = (s, at) => {
    for (let k = 0; k < s.length; k += 1) { lines.push(line); rawAt.push(at); }
    text += s;
  };
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9-]{0,30})(?:[\s/][^<>]{0,400})?>/y;
  const entityRe = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,10}));/y;
  const hyphenBreakRe = /-[ \t]*(?:\r\n|\n|\r)[ \t>]*(?=\p{L})/uy;
  let i = 0;
  while (i < raw.length) {
    if (raw.startsWith('\r\n', i)) { push('\n', i); line += 1; i += 2; continue; }
    const cp = raw.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    if (cp === 0x0a || cp === 0x0d || cp === 0x2028 || cp === 0x2029 || cp === 0x85) {
      push('\n', i); line += 1; i += width; continue;
    }
    if (stripTags && !mutate.has('no-tag-strip')) {
      if (raw.startsWith('<!--', i)) { i += 4; continue; }
      if (raw.startsWith('-->', i)) { i += 3; continue; }
      tagRe.lastIndex = i;
      const tag = tagRe.exec(raw);
      if (tag) {
        const breaks = (tag[0].match(/\r\n|\n|\r/g) || []).length;
        if (!INLINE_TAGS.has(tag[1].toLowerCase())) push(' ', i);
        line += breaks;
        i += tag[0].length;
        continue;
      }
    }
    if (cp === 0x26 && !mutate.has('no-entity')) {
      entityRe.lastIndex = i;
      const ent = entityRe.exec(raw);
      if (ent) {
        let decoded = null;
        if (ent[1] !== undefined || ent[2] !== undefined) {
          const value = ent[1] !== undefined ? Number(ent[1]) : parseInt(ent[2], 16);
          if (value > 0 && value <= 0x10ffff) decoded = String.fromCodePoint(value);
        } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, ent[3].toLowerCase())) {
          decoded = NAMED_ENTITIES[ent[3].toLowerCase()];
        }
        if (decoded !== null) {
          const dcp = decoded === '' ? null : decoded.codePointAt(0);
          if (dcp !== null && !isInvisible(dcp) && !isVariationSelector(dcp)) push(foldChar(decoded), i);
          i += ent[0].length;
          continue;
        }
      }
    }
    if (cp === 0x2d && !mutate.has('no-hyphen-join')) {
      hyphenBreakRe.lastIndex = i;
      const brk = hyphenBreakRe.exec(raw);
      if (brk && i > 0 && /\p{L}/u.test(raw[i - 1])) {
        line += (brk[0].match(/\r\n|\n|\r/g) || []).length;
        i += brk[0].length;
        continue;
      }
    }
    if (cp === 0x09) { push(' ', i); i += width; continue; }
    if (isInvisible(cp) || isVariationSelector(cp)) {
      if (mutate.has('keep-invisible')) push(String.fromCodePoint(cp), i);
      i += width;
      continue;
    }
    const ch = String.fromCodePoint(cp);
    if (MARKDOWN_JOINERS.has(ch) && !mutate.has('no-markdown-join')) { i += width; continue; }
    push(mutate.has('no-fold') ? ch.toLowerCase() : foldChar(ch), i);
    i += width;
  }
  return { text, lines, rawAt };
}

// Letters and digits only: a phrase split by spaces, line breaks, punctuation or markup still reads as one run.
function squash(view, mutate) {
  if (mutate.has('no-squash')) return { text: '', lines: [], rawAt: [] };
  let text = '';
  const lines = [];
  const rawAt = [];
  for (let k = 0; k < view.text.length; k += 1) {
    const ch = view.text[k];
    if (/[\p{L}\p{N}]/u.test(ch)) { text += ch; lines.push(view.lines[k]); rawAt.push(view.rawAt[k]); }
  }
  return { text, lines, rawAt };
}

// ---------------------------------------------------------------- the closed rule table
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const SEP = '[^\\p{L}\\p{N}]{1,24}';
const START = '(?:^|\\n|[.!?;]\\s)[ \\t>#\\-+|]*(?:\\d{1,3}[.)][ \\t]*)?';
const alt = words => `(?:${words.join('|')})`;
// Closed spelling of two listed short signals: only 0-24 whitespace characters between their letters.
// Word boundaries remain on F/R, so "you are nowhere" and embedded "agitpushy" stay clean.
const spell = value => value.split('').join('[ \\t\\n]{0,24}');
const OVERRIDE_FILLER_LIMIT = 6;

const OVERRIDE_VERB_EN = alt(['ignore', 'disregard', 'forget', 'override', 'bypass']);
const FILLER_EN = alt(['all', 'any', 'the', 'your', 'of', 'these', 'those', 'my', 'every',
  'and', 'many', 'single', 'one', 'each', 'our', 'their', 'both', 'absolutely', 'without', 'exception', 'remaining']);
const QUAL_EN = alt(['previous', 'prior', 'above', 'earlier', 'preceding', 'foregoing', 'former', 'system', 'original']);
const OBJECT_EN = alt(['instructions?', 'prompts?', 'rules?', 'directions?', 'directives?', 'guidelines?',
  'messages?', 'context', 'orders?', 'commands?']);
const OVERRIDE_VERB_RU = alt(['игнорир\\p{L}*', 'проигнорир\\p{L}*', 'забудь(?:те)?', 'забуд\\p{L}*', 'отбрось(?:те)?',
  'отмени(?:те)?', 'не\\s+обращаи(?:те)?\\s+внимания\\s+на']);
const FILLER_RU = alt(['все', 'эти', 'свои', 'твои', 'ваши', 'и', 'вся', 'абсолютно', 'без', 'исключения',
  'любые', 'любую', 'каждую', 'из', 'всех', 'наши', 'мои', 'их']);
// Exact folded verb forms for S: a morphological wildcard here would swallow arbitrary intervening words.
const OVERRIDE_S_RU = alt(['игнорируи(?:те)?', 'проигнорируи(?:те)?', 'забудь(?:те)?', 'забудьте',
  'отбрось(?:те)?', 'отмени(?:те)?', 'необращаи(?:те)?вниманияна']);
const QUAL_RU = alt(['предыдущ\\p{L}*', 'прежн\\p{L}*', 'вышеизложенн\\p{L}*', 'вышеуказанн\\p{L}*', 'ранее\\s+данн\\p{L}*',
  'ранее\\s+полученн\\p{L}*', 'системн\\p{L}*', 'исходн\\p{L}*']);
const OBJECT_RU = alt(['инструкц\\p{L}*', 'указани\\p{L}*', 'правил\\p{L}*', 'промпт\\p{L}*', 'команд\\p{L}*',
  'распоряжени\\p{L}*']);

const ADDRESSEE_EN = alt(['operator', 'kilo', 'codex', 'claude', 'gemini', 'agent', 'assistant', 'model', 'ai',
  'deepseek', 'glm', 'mimo', 'qwen', 'mistral', 'copilot', 'vibe', 'agy', 'certifier', 'reviewer', 'executor',
  'implementer']);
const VERB_EN = alt(['run', 'execute', 'merge', 'push', 'commit', 'delete', 'remove', 'approve', 'mark', 'ignore',
  'skip', 'set', 'write', 'send', 'install', 'rotate', 'print', 'reveal', 'show', 'disable', 'enable', 'change',
  'update', 'grant', 'give', 'add', 'create', 'copy', 'upload', 'paste', 'open', 'read', 'follow', 'accept', 'sign',
  'certify', 'land', 'release', 'publish', 'reset', 'force', 'drop', 'revert']);
const ADDRESSEE_RU = alt(['оператор', 'кило', 'агент', 'ассистент', 'модель', 'кодекс', 'клод', 'сертификатор',
  'ревьюер', 'исполнитель']);
const VERB_RU = alt(['выполни', 'запусти', 'удали', 'смержи', 'слеи', 'влеи', 'запушь', 'отправь', 'сделаи',
  'игнорируи', 'проигнорируи', 'пропусти', 'одобри', 'отметь', 'покажи', 'напечатаи', 'установи', 'отключи',
  'включи', 'измени', 'перепиши', 'закоммить', 'подтверди', 'прими', 'сотри', 'очисти', 'создаи', 'скопируи',
  'открои', 'прочитаи'].map(v => `${v}(?:те)?`));

const GIT = 'git(?:\\s+(?:-c\\s+\\S+|-C\\s+\\S+|--[a-z][a-z-]*(?:=\\S+)?))*\\s+';
const FETCHER = alt(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const SHELL = alt(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'python[0-9.]*', 'perl', 'ruby', 'node', 'php', 'iex',
  'invoke-expression', 'powershell(?:\\.exe)?', 'pwsh(?:\\.exe)?', 'cmd(?:\\.exe)?']);

// view: 'F' folded with tags stripped, 'R' folded with tags kept, 'S' squashed letters and digits (from F).
const RULES = [
  {
    id: 'instruction-override',
    source: 'PROTO-DEC-0132 item 4 "ignore previous"; b-scan rule 1',
    grammar: 'VERB(ignore|disregard|forget|override|bypass) FILLER{0,6}(all|any|the|your|of|these|those|my|every|and|many|single|one|each|our|their|both|absolutely|without|exception|remaining) QUALIFIER(previous|prior|above|earlier|preceding|foregoing|former|system|original) OBJECT(instruction|prompt|rule|direction|directive|guideline|message|context|order|command), or VERB "all" QUALIFIER; Russian: игнорируй|забудь|отбрось|отмени|не обращай внимания на + FILLER{0,6}(все|эти|свои|твои|ваши|и|вся|абсолютно|без|исключения|любые|любую|каждую|из|всех|наши|мои|их) + предыдущие|прежние|вышеизложенные|ранее данные|системные|исходные + инструкции|указания|правила|промпт|команды|распоряжения; split-proof form on the squashed view',
    patterns: [
      { view: 'FR', re: `${B}(?<at>${OVERRIDE_VERB_EN})(?:${SEP}${FILLER_EN}){0,${OVERRIDE_FILLER_LIMIT}}${SEP}${QUAL_EN}${SEP}${OBJECT_EN}${E}` },
      { view: 'FR', re: `${B}(?<at>${OVERRIDE_VERB_EN})${SEP}all${SEP}${QUAL_EN}${E}` },
      { view: 'FR', re: `${B}(?<at>${OVERRIDE_VERB_RU})(?:${SEP}${FILLER_RU}){0,${OVERRIDE_FILLER_LIMIT}}${SEP}${QUAL_RU}${SEP}${OBJECT_RU}${E}` },
      { view: 'S', re: `(?<at>${OVERRIDE_VERB_EN})(?:${FILLER_EN}){0,${OVERRIDE_FILLER_LIMIT}}${QUAL_EN}${OBJECT_EN}` },
      { view: 'S', re: `(?<at>${OVERRIDE_S_RU})(?:${FILLER_RU}){0,${OVERRIDE_FILLER_LIMIT}}${QUAL_RU.replaceAll('\\s+', '')}${OBJECT_RU}` },
    ],
  },
  {
    id: 'persona-swap',
    source: 'PROTO-DEC-0132 item 4 "you are now"; b-scan rule 2',
    grammar: '"you are now" (also letters with 0-24 whitespace between them and outer word boundaries) or "you\'re/you\u2019re/youre now" | "from now on you are/will/must" | "you will now act/behave/be/respond" | "new system prompt" | "your new role/persona/instructions" | "pretend/imagine to be / you are / that you are" | sentence-initial "act as a/an/the/my/if/though"; Russian: "теперь ты", "ты теперь", "представь (себе), что ты", "новый системный промпт", "твоя новая роль"',
    patterns: [
      { view: 'FR', re: `${B}(?<at>${spell('youarenow')})${E}` },
      { view: 'FR', re: `${B}(?<at>you)${SEP}are${SEP}now${E}` },
      { view: 'FR', re: `${B}(?<at>you)(?:['’]?re)${SEP}now${E}` },
      { view: 'FR', re: `${B}(?<at>from)${SEP}now${SEP}on${SEP}you${SEP}(?:are|will|must|shall)${E}` },
      { view: 'FR', re: `${B}(?<at>you)${SEP}will${SEP}now${SEP}(?:act|behave|be|respond|answer|follow)${E}` },
      { view: 'FR', re: `${B}(?<at>new)${SEP}system${SEP}prompt` },
      { view: 'FR', re: `${B}(?<at>your)${SEP}new${SEP}(?:role|persona|instructions?)${E}` },
      { view: 'FR', re: `${B}(?<at>pretend|imagine)${SEP}(?:to${SEP}be|you${SEP}are|that${SEP}you${SEP}are)${E}` },
      { view: 'FR', re: `${START}(?<at>act)${SEP}as${SEP}(?:an?|the|my|if|though)${E}` },
      { view: 'FR', re: `${B}(?<at>теперь)${SEP}ты${E}` },
      { view: 'FR', re: `${B}(?<at>ты)${SEP}теперь${E}` },
      { view: 'FR', re: `${B}(?<at>представь)(?:${SEP}себе)?${SEP}что${SEP}ты${E}` },
      { view: 'FR', re: `${B}(?<at>новыи)${SEP}системныи${SEP}промпт` },
      { view: 'FR', re: `${B}(?<at>твоя)${SEP}новая${SEP}роль${E}` },
      { view: 'S', re: '(?<at>newsystemprompt|fromnowonyouare|новыисистемныипромпт)' },
    ],
  },
  {
    id: 'operator-addressing',
    source: 'PROTO-DEC-0132 item 4 "addressing the operator"; b-scan rule 3',
    grammar: 'at a line or sentence start: ADDRESSEE(operator|kilo|codex|claude|gemini|agent|assistant|model|ai|deepseek|glm|mimo|qwen|mistral|copilot|vibe|agy|certifier|reviewer|executor|implementer) [,:!] [please] IMPERATIVE(run|execute|merge|push|commit|delete|...|revert); Russian ADDRESSEE(оператор|кило|агент|ассистент|модель|кодекс|клод|сертификатор|ревьюер|исполнитель) [,:!] [пожалуйста] IMPERATIVE(выполни|запусти|удали|смержи|...); anywhere: "run/execute the following", "выполни следующее/эту команду/команды"',
    patterns: [
      { view: 'FR', re: `${START}(?<at>${ADDRESSEE_EN})\\s*[,:!]\\s*(?:please${SEP})?${VERB_EN}${E}` },
      { view: 'FR', re: `${START}(?<at>${ADDRESSEE_RU})\\s*[,:!]\\s*(?:пожалуиста${SEP})?${VERB_RU}${E}` },
      { view: 'FR', re: `${B}(?<at>run|execute)${SEP}(?:the${SEP})?following${E}` },
      { view: 'FR', re: `${B}(?<at>выполни(?:те)?)${SEP}(?:следующ\\p{L}*|эту${SEP}команду|команд\\p{L}*)${E}` },
    ],
  },
  {
    id: 'dangerous-command',
    source: 'PROTO-DEC-0132 item 4 "git push/--force/reset/rm commands"; b-scan rule 4',
    grammar: 'git [global options] push | reset ... --hard | clean -..f | branch -d/-D (the view is case-folded, so both) | filter-branch | filter-repo | update-ref -d | stash drop|clear; git push also as letters with 0-24 whitespace between them and outer word boundaries; rm with a recursive flag; del|erase /f|/s|/q; rd|rmdir /s; Remove-Item ... -Recurse|-Force; format <drive>:',
    patterns: [
      { view: 'FR', re: `${B}(?<at>${spell('gitpush')})${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})push${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})reset(?:\\s+\\S+){0,2}?\\s+--hard${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})clean\\s+-[a-z]*f` },
      { view: 'FR', re: `${B}(?<at>${GIT})branch\\s+(?:-d\\s+--force|--force\\s+-d|--delete\\s+--force|-D)${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})(?:filter-branch|filter-repo)${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})update-ref\\s+-d${E}` },
      { view: 'FR', re: `${B}(?<at>${GIT})stash\\s+(?:drop|clear)${E}` },
      { view: 'FR', re: `${B}(?<at>rm)\\s+(?:-[a-z]*\\s+)*-[a-z]*r[a-z]*${E}` },
      { view: 'FR', re: `${B}(?<at>rm)\\s+(?:\\S+\\s+)*--recursive${E}` },
      { view: 'FR', re: `${B}(?<at>del|erase)(?:\\s+/[a-z]+)*\\s+/[fsq]${E}` },
      { view: 'FR', re: `${B}(?<at>rd|rmdir)(?:\\s+/[a-z]+)*\\s+/s${E}` },
      { view: 'FR', re: `${B}(?<at>remove-item)${E}[^\\n]{0,240}?\\s-(?:recurse|force|r)${E}` },
      { view: 'FR', re: `${B}(?<at>format)\\s+[a-z]:(?![\\p{L}\\p{N}/])` },
    ],
  },
  {
    id: 'pipe-to-shell',
    source: 'PROTO-DEC-0132 item 4 "curl ... | sh"; b-scan rule 5',
    grammar: 'FETCHER(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod) ... (0-8 intermediate pipe segments, 1-400 characters each) | [sudo] SHELL(sh|bash|zsh|dash|ksh|fish|python|perl|ruby|node|php|iex|invoke-expression|powershell|pwsh|cmd) on one line; SHELL <(curl|wget ...) or SHELL -c "$(curl|wget ...)"; "iex(" ; "invoke-expression"; powershell -e/-enc/-encodedcommand <base64>',
    patterns: [
      { view: 'FR', re: `${B}(?<at>${FETCHER})${E}[^\\n|]{0,400}(?:\\|[ \\t]*[^\\n|]{1,400}){0,8}\\|[ \\t]*(?:sudo[ \\t]+)?${SHELL}${E}` },
      { view: 'FR', re: `${B}(?<at>bash|sh|zsh|source)(?:\\s+-[a-z]+)*\\s+["']?[<$]\\(\\s*(?:curl|wget)${E}` },
      { view: 'FR', re: `${B}(?<at>iex)\\s*\\(` },
      { view: 'FR', re: `${B}(?<at>invoke-expression)${E}` },
      { view: 'FR', re: `${B}(?<at>powershell|pwsh)(?:\\.exe)?${E}[^\\n]{0,200}?\\s-(?:e|enc|encodedcommand)\\s+[a-z0-9+/=]{16,}` },
    ],
  },
  {
    id: 'approved-by-outside-decisions',
    source: 'PROTO-DEC-0132 item 4 "Approved by: lines outside DECISIONS"; b-scan rule 6; field grammar of .ai/bin/validator/governance.cjs:103',
    grammar: 'a line whose content, after optional markdown prefixes (> # - + | and list numbers), begins with "approved by" (space, _ or - between) followed by ":" - the field form that grants approval in the decision log; the scanner is never pointed at .ai/DECISIONS.md (not in its input domain)',
    patterns: [
      { view: 'FR', re: `(?:^|\\n)[ \\t>#\\-+|]*(?:\\d{1,3}[.)][ \\t]*)?(?<at>approved)[ \\t_-]*by[ \\t]*:` },
    ],
  },
  {
    id: 'long-base64',
    source: 'PROTO-DEC-0132 item 4 "long base64 strings"; b-scan rule 7',
    grammar: 'raw text: a run of 200+ characters of the standard [A-Za-z0-9+/] or the url-safe [A-Za-z0-9_-] alphabet (optional = padding) holding an upper-case letter, a lower-case letter and a digit; or 2+ consecutive lines that each consist only of such characters (16+ per line, a wrapped block) adding up to 200+ with the same mix',
    raw: true,
  },
  {
    id: 'zero-width',
    source: 'PROTO-DEC-0132 item 4 "zero-width characters"; b-scan rule 8',
    grammar: 'raw text: any code point outside the visible set, i.e. of category Cc (except TAB, LF and the CR of a CRLF pair), Cf (zero-width, bidi controls, tags, BOM, soft hyphen), Co, Cn, Cs, Zl, Zp, the invisible letters U+115F U+1160 U+3164 U+FFA0 U+034F, or a run of 2+ variation selectors',
    raw: true,
  },
];

const COMPILED = RULES.filter(r => !r.raw).map(r => ({
  id: r.id,
  patterns: r.patterns.map(p => ({ view: p.view, re: new RegExp(foldPattern(p.re), 'giud') })),
}));

// ---------------------------------------------------------------- raw rules
function lineStarts(raw) {
  const starts = [0];
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c === 0x0a) starts.push(i + 1);
    else if (c === 0x0d && raw.charCodeAt(i + 1) !== 0x0a) starts.push(i + 1);
  }
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

function base64Mix(s) {
  return /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
}

function scanBase64(raw, starts, mutate) {
  const hits = [];
  for (const re of [/[A-Za-z0-9+/]{200,}={0,2}/g, /[A-Za-z0-9_-]{200,}={0,2}/g]) {
    for (const m of raw.matchAll(re)) {
      if (base64Mix(m[0])) hits.push({ line: lineOf(starts, m.index), excerpt: `len=${m[0].length}` });
    }
  }
  if (!mutate.has('no-wrapped-base64')) {
    const rows = raw.split(/\r\n|\n|\r/);
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const joined = run.map(r => r.text).join('');
        if (joined.length >= 200 && base64Mix(joined)) hits.push({ line: run[0].line, excerpt: `len=${joined.length} lines=${run.length}` });
      }
      run = [];
    };
    rows.forEach((row, index) => {
      const m = /^[ \t>]*([A-Za-z0-9+/_=-]{16,})[ \t]*$/.exec(row);
      if (m) run.push({ line: index + 1, text: m[1] }); else flush();
    });
    flush();
  }
  return hits;
}

function scanInvisible(raw, starts) {
  const perLine = new Map();
  const note = (index, label) => {
    const line = lineOf(starts, index);
    if (!perLine.has(line)) perLine.set(line, new Map());
    const counts = perLine.get(line);
    counts.set(label, (counts.get(label) || 0) + 1);
  };
  let selectorRun = 0;
  let selectorStart = 0;
  for (let i = 0; i < raw.length;) {
    const cp = raw.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
    if (isVariationSelector(cp)) {
      if (selectorRun === 0) selectorStart = i;
      selectorRun += 1;
    } else {
      if (selectorRun >= 2) note(selectorStart, `variation-selector-run(${selectorRun})`);
      selectorRun = 0;
      const crlf = cp === 0x0d && raw.charCodeAt(i + 1) === 0x0a;
      if (cp !== 0x09 && cp !== 0x0a && !crlf && (isInvisible(cp) || cp === 0x2028 || cp === 0x2029)) note(i, label);
    }
    i += width;
  }
  if (selectorRun >= 2) note(selectorStart, `variation-selector-run(${selectorRun})`);
  return [...perLine.entries()].map(([line, counts]) => ({
    line,
    excerpt: [...counts.entries()].map(([label, n]) => (n > 1 ? `${label} x${n}` : label)).join(', '),
  }));
}

// ---------------------------------------------------------------- scanning
function sanitizeExcerpt(s) {
  let out = '';
  for (const ch of s.replace(/\s+/g, ' ').trim()) {
    const cp = ch.codePointAt(0);
    out += isInvisible(cp) || isVariationSelector(cp) ? `\\u{${cp.toString(16)}}` : ch;
    if (out.length >= EXCERPT_MAX) { out = `${out.slice(0, EXCERPT_MAX)}...`; break; }
  }
  return out;
}

function scanText(raw, options = {}) {
  const mutate = new Set(options.mutate || []);
  const starts = lineStarts(raw);
  const F = buildView(raw, { stripTags: true, mutate });
  const R = buildView(raw, { stripTags: false, mutate });
  const S = squash(F, mutate);
  const views = { F, R, S };
  const found = new Map();
  const add = (rule, line, excerpt) => {
    const key = `${rule}\u0000${line}`;
    if (!found.has(key)) found.set(key, { rule, line, excerpt });
  };
  for (const rule of COMPILED) {
    if (mutate.has(`disable:${rule.id}`)) continue;
    for (const p of rule.patterns) {
      for (const viewName of p.view === 'FR' ? ['F', 'R'] : [p.view]) {
        const v = views[viewName];
        p.re.lastIndex = 0;
        for (const m of v.text.matchAll(p.re)) {
          const at = m.indices && m.indices.groups && m.indices.groups.at ? m.indices.groups.at[0] : m.index;
          const endView = Math.min(m.index + m[0].length, v.rawAt.length) - 1;
          const rawStart = v.rawAt[at];
          const rawEnd = endView >= 0 ? v.rawAt[endView] + 1 : rawStart + 1;
          add(rule.id, v.lines[at], sanitizeExcerpt(raw.slice(rawStart, Math.max(rawEnd, rawStart + 1))));
        }
      }
    }
  }
  if (!mutate.has('disable:long-base64')) for (const h of scanBase64(raw, starts, mutate)) add('long-base64', h.line, h.excerpt);
  if (!mutate.has('disable:zero-width')) for (const h of scanInvisible(raw, starts)) add('zero-width', h.line, h.excerpt);
  const order = RULES.map(r => r.id);
  return [...found.values()].sort((a, b) => a.line - b.line || order.indexOf(a.rule) - order.indexOf(b.rule));
}

// Accepted encodings (closed): UTF-8 with or without BOM, UTF-16 LE or BE with BOM. Anything else is UNKNOWN.
function decode(buffer) {
  let encoding = 'utf-8';
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) encoding = 'utf-16le';
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) encoding = 'utf-16be';
  let bytes = buffer;
  if (encoding !== 'utf-8') {
    try { bytes = Buffer.from(new TextDecoder(encoding, { fatal: true }).decode(buffer), 'utf8'); }
    catch { return { ok: false, reason: 'invalid-utf16' }; }
  }
  const d = textSafe.decode(bytes, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) return { ok: false, reason: d.problems[0].code === 'INVALID_UTF8' ? 'not-utf8' : `invalid-text:${d.problems[0].code}` };
  if (d.text.trim() === '') return { ok: false, reason: 'empty-content' };
  return { ok: true, text: d.text, encoding };
}

// Anchor at the drive/filesystem root, rather than a possibly linked input parent.
// realInside walks EVERY input ancestor; no link alias is granted by the caller.
function guardInput(input) {
  const absolute = path.isAbsolute(input) ? input : `${process.cwd()}${path.sep}${input}`;
  const g = pathSafe.realInside(path.parse(absolute).root, absolute, { allowRoot: true, refuseHardlinks: true });
  if (!g.ok) return { ...g, reason: g.reason === 'link' ? 'link-not-followed' : g.reason };
  return g;
}

function scanFile(filePath, options = {}) {
  const guarded = guardInput(filePath);
  if (!guarded.ok) return { path: filePath, status: 'unknown', reason: guarded.reason };
  let stat;
  try { stat = fs.lstatSync(filePath); } catch (error) { return { path: filePath, status: 'unknown', reason: `unreadable:${error.code || 'error'}` }; }
  if (stat.isSymbolicLink()) return { path: filePath, status: 'unknown', reason: 'link-not-followed' };
  if (!stat.isFile()) return { path: filePath, status: 'unknown', reason: 'not-a-regular-file' };
  if (stat.size > MAX_BYTES) return { path: filePath, status: 'unknown', reason: `too-large:${stat.size}` };
  let buffer;
  try { buffer = fs.readFileSync(filePath); } catch (error) { return { path: filePath, status: 'unknown', reason: `unreadable:${error.code || 'error'}` }; }
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const decoded = decode(buffer);
  if (!decoded.ok) return { path: filePath, status: 'unknown', reason: decoded.reason, sha256 };
  return { path: filePath, status: 'scanned', encoding: decoded.encoding, sha256, hits: scanText(decoded.text, options) };
}

// Inputs: every regular file under the given paths. Links and junctions are never followed (each is UNKNOWN),
// so a link cannot pull a foreign tree into the scan; a directory with no regular file is UNKNOWN (empty).
function collectTargets(inputs) {
  const files = [];
  const unknown = [];
  const walk = (dir, shown) => {
    const guarded = guardInput(dir);
    if (!guarded.ok) { unknown.push({ path: shown, status: 'unknown', reason: guarded.reason }); return 0; }
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) {
      unknown.push({ path: shown, status: 'unknown', reason: `unreadable:${error.code || 'error'}` });
      return 0;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    let count = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const label = `${shown}/${entry.name}`;
      if (entry.isSymbolicLink()) unknown.push({ path: label, status: 'unknown', reason: 'link-not-followed' });
      else if (entry.isDirectory()) count += walk(full, label);
      else if (entry.isFile()) { files.push({ full, label }); count += 1; } else unknown.push({ path: label, status: 'unknown', reason: 'not-a-regular-file' });
    }
    return count;
  };
  for (const input of inputs) {
    const shown = input.replace(/\\/g, '/').replace(/\/+$/, '') || input;
    const guarded = guardInput(input);
    if (!guarded.ok) { unknown.push({ path: shown, status: 'unknown', reason: guarded.reason }); continue; }
    let stat;
    try { stat = fs.lstatSync(input); } catch (error) {
      unknown.push({ path: shown, status: 'unknown', reason: `missing:${error.code || 'error'}` });
      continue;
    }
    if (stat.isSymbolicLink()) unknown.push({ path: shown, status: 'unknown', reason: 'link-not-followed' });
    else if (stat.isDirectory()) { if (walk(input, shown) === 0) unknown.push({ path: shown, status: 'unknown', reason: 'empty' }); } else if (stat.isFile()) files.push({ full: input, label: shown });
    else unknown.push({ path: shown, status: 'unknown', reason: 'not-a-regular-file' });
  }
  return { files, unknown };
}

function run(inputs, options = {}) {
  const { files, unknown } = collectTargets(inputs);
  const results = [];
  for (const f of files) {
    const r = scanFile(f.full, options);
    r.path = f.label;
    results.push(r);
  }
  const all = [...results, ...unknown];
  const unknownCount = all.filter(r => r.status === 'unknown').length;
  const hitCount = results.reduce((n, r) => n + (r.hits ? r.hits.length : 0), 0);
  const exit = unknownCount > 0 ? 2 : hitCount > 0 ? 1 : 0;
  return { schema: 'injection-scan/1', exit, files: results.filter(r => r.status === 'scanned').length, hits: hitCount, unknown: unknownCount, results: all };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 1 && args[0] === '--rules') {
    for (const r of RULES) process.stdout.write(`${r.id}\t${r.source}\t${r.grammar}\n`);
    return 0;
  }
  let json = false;
  const inputs = [];
  for (const a of args) {
    if (a === '--json') json = true;
    else if (a.startsWith('--')) { process.stderr.write(`injection-scan: unknown option ${a}\n`); return 2; } else inputs.push(a);
  }
  if (inputs.length === 0) {
    process.stderr.write('usage: node docs/ops/injection-scan.cjs [--json] <file-or-directory>... | --rules\n');
    return 2;
  }
  const report = run(inputs);
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.exit;
  }
  for (const r of report.results) {
    if (r.status === 'unknown') process.stdout.write(`UNKNOWN ${r.path} ${r.reason}\n`);
    else for (const h of r.hits) process.stdout.write(`HIT ${h.rule} ${r.path}:${h.line} ${h.excerpt}\n`);
  }
  process.stdout.write(`RESULT exit=${report.exit} files=${report.files} hits=${report.hits} unknown=${report.unknown}\n`);
  return report.exit;
}

module.exports = { RULES, scanText, scanFile, collectTargets, run, decode, guardInput, buildView, foldChar, foldPattern };

if (require.main === module) process.exitCode = main(process.argv);
