'use strict';
// P-CITES policy only. The ordinary L7 citation grammar stays strict.
// Every alternative still uses the strict guarded path and line resolver.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const EXT = /\.(?:md|cjs|js|mjs|json|jsonl|ps1|psm1|sh|py|ts|tsx|yml|yaml|toml|txt|csv|html|css|xml)$/i;
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Preserve token boundaries and line breaks while hiding non-code text. Template
// interpolation is hidden too, including nested templates and quoted braces.
function declarationText(source) {
  const commentEnd = i => source[i + 1] === '/'
    ? (source.indexOf('\n', i + 2) < 0 ? source.length : source.indexOf('\n', i + 2))
    : (source.indexOf('*/', i + 2) < 0 ? source.length : source.indexOf('*/', i + 2) + 2);
  const quotedEnd = (i, quote) => {
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') { i++; continue; }
      if (source[i] === quote) return i + 1;
      if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
        let depth = 1;
        for (i += 2; i < source.length && depth; i++) {
          const ch = source[i];
          if ('\'"`'.includes(ch)) i = quotedEnd(i, ch) - 1;
          else if (ch === '/' && /[/*]/.test(source[i + 1] || '')) i = commentEnd(i) - 1;
          else if (ch === '{') depth++;
          else if (ch === '}') depth--;
        }
        i--;
      }
    }
    return source.length;
  };
  const parts = [];
  for (let i = 0; i < source.length;) {
    const start = i, ch = source[i];
    if ('\'"`'.includes(ch)) i = quotedEnd(i, ch);
    else if (ch === '/' && /[/*]/.test(source[i + 1] || '')) i = commentEnd(i);
    else if (ch === '/') {
      // A slash-delimited literal must not manufacture a declaration either.
      // Ambiguous division spans are conservatively hidden, never accepted.
      let end = i + 1, inClass = false;
      for (; end < source.length && !/[\r\n]/.test(source[end]); end++) {
        if (source[end] === '\\') { end++; continue; }
        if (source[end] === '[') inClass = true;
        if (source[end] === ']') inClass = false;
        if (source[end] === '/' && !inClass) break;
      }
      // In division followed by a comment, that comment opener is not a regex
      // terminator. Hide through the comment so its text cannot escape masking.
      i = source[end] === '/' ? /[/*]/.test(source[end + 1] || '') ? commentEnd(end) : end + 1 : i + 1;
    } else { parts.push(ch); i++; continue; }
    parts.push(source.slice(start, i).replace(/[^\r\n]/g, ' '));
  }
  return parts.join('');
}

function archiveWarning(doc) {
  // Archived documents move verbatim. Their retained citations are history,
  // identified by the source's canonical home rather than the target's home.
  if (doc.startsWith('docs/archive/') && path.posix.normalize(doc) === doc) {
    return { outcome: 'warning', warning: 'archived-document', reason: 'citation retained in an immutable historical document' };
  }
  return null;
}

function calibrateCitation(ctx, doc, c, strict, { resolvePath, readText, source = '', explanation = source }) {
  if (strict.outcome !== 'unresolved') return strict;
  const warn = (warning, reason, extra = {}) => ({ outcome: 'warning', warning, reason, ...extra });
  const archivedSource = archiveWarning(doc);
  if (archivedSource) return archivedSource;
  if (c.cls === 'commit' && /^\d{7,39}$/.test(c.token)) {
    const literal = new RegExp(`(?<![\\p{L}\\p{N}_])(?:exit code|code|\\u043a\\u043e\\u0434(?:\\u043e\\u043c)?)\\s+\x60?${escape(c.token)}(?=\x60|[\\s.,;)]|$)`, 'iu').exec(source);
    const offset = literal && literal.index + literal[0].length - c.token.length;
    if (literal && (offset === c.col - 1 || offset === c.col)) return warn('numeric-code-literal', 'an explicitly labelled numeric exit code, not a commit id');
  }
  if (!['path', 'path-line'].includes(c.cls)) return strict;
  const select = token => {
    if (ctx.fileSet.has(token)) return { target: token };
    const local = path.posix.join(path.posix.dirname(doc), token);
    if (ctx.fileSet.has(local)) return { target: local, resolution: 'document-relative' };
    const hits = ctx.files.filter(f => f.endsWith(`/${token}`));
    return hits.length === 1 ? { target: hits[0], resolution: 'unique-suffix' } : { hits };
  };
  const checked = (selected, lines) => {
    const r = resolvePath(selected.target, lines);
    return r.outcome === 'resolved' ? { ...r, resolution: selected.resolution } : r;
  };
  const selected = select(c.token);
  if (c.malformed) {
    // A symbol address is a warning only for a declared function of a real file.
    if (c.ref === `${c.token}:${c.lines}` && /^[A-Za-z_$][\w$]*$/.test(c.lines || '') && selected.target) {
      const r = checked(selected, null);
      if (r.outcome !== 'resolved') return r;
      const declaration = new RegExp(`(?:function\\s+${escape(c.lines)}\\s*\\(|(?:const|let|var)\\s+${escape(c.lines)}\\s*=\\s*(?:async\\s+)?(?:function\\b|\\([^;\\n]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>))`);
      if (declaration.test(declarationText(readText(selected.target)))) return warn('function-address', 'a declared function address, not a line number', { target: selected.target });
    }
    // Numeric typographic ranges have the same bounds checks as ASCII ranges.
    const ascii = (c.lines || '').replace(/[\u2013\u2014]/g, '-');
    if (c.ref === `${c.token}:${c.lines}` && ascii !== c.lines && /^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(ascii) && selected.target) {
      return checked({ ...selected, resolution: 'typographic-range' }, ascii);
    }
    return strict;
  }
  if (selected.target) return checked(selected, c.lines);

  // A slash following a complete module filename separates a list, never hides a
  // missing member. Extensionless members are accepted only with one real match.
  const parts = c.token.split('/');
  if (parts.length > 1 && EXT.test(parts[0])) {
    const targets = [];
    for (const part of parts) {
      const anchor = targets[0];
      const member = EXT.test(part) ? part : `${part}${path.posix.extname(anchor || parts[0])}`;
      const relatives = anchor ? [
        path.posix.join(path.posix.dirname(anchor), member),
        path.posix.join(anchor.replace(EXT, ''), member),
      ].filter(f => ctx.fileSet.has(f)) : [];
      const choices = relatives.length === 1 ? { target: relatives[0] } : EXT.test(part) ? select(part) : (() => {
        const hits = ctx.files.filter(f => path.posix.basename(f).replace(EXT, '') === part);
        return hits.length === 1 ? { target: hits[0] } : { hits };
      })();
      if (!choices.target) return { outcome: 'unresolved', reason: `module-list member ${part} has ${choices.hits.length} repository matches` };
      const r = checked(choices, c.lines);
      if (r.outcome !== 'resolved') return r;
      targets.push(choices.target);
    }
    return warn('module-list', 'every slash-joined module resolves', { targets });
  }

  // Closed placeholder vocabulary; ordinary missing paths never match by mood.
  const placeholder = parts.some(p => /^(?:NAME|REPORT)(?:\.|$)|^(?:launches-)?(?:YYYYMMDD|YYYY|MM|DD)(?:[.-]|$)|^rollout-\.\.\.-ID\./.test(p)) || /^example\.(?:cjs|js|mjs)$/.test(parts.at(-1));
  if (placeholder && !c.lines) return warn('template-placeholder', 'a filename template, not a claim about an existing file');

  // Case folding is permitted only for an explicitly explained classifier literal.
  const folded = ctx.files.filter(f => f.toLowerCase() === c.token.toLowerCase());
  if (!c.lines && folded.length === 1 && /(?:lower-case classifier literal|classifier literal|\u043b\u0438\u0442\u0435\u0440\u0430\u043b \u043a\u043b\u0430\u0441\u0441\u0438\u0444\u0438\u043a\u0430\u0442\u043e\u0440\u0430)/i.test(explanation)) {
    const r = resolvePath(folded[0], null);
    if (r.outcome !== 'resolved') return r;
    return warn('classifier-literal', 'explicit classifier spelling of a real path', { target: folded[0] });
  }

  // A branch-qualified git-show argument is evidence in that branch, not a claim
  // of a file in this checkout. Verify the object, without reading any other tree.
  const branch = new RegExp(`\\bgit show ([A-Za-z0-9][A-Za-z0-9_./-]*):${escape(c.token)}(?=[\\s\x60'"),;]|$)`).exec(source);
  if (branch && branch.index + branch[0].length - c.token.length === c.col - 1 && !c.lines && ctx.mode === 'git') {
    const r = spawnSync('git', ['-C', ctx.realRoot, 'cat-file', '-t', `${branch[1]}:${c.token}`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (r.status === 0 && r.stdout.trim() === 'blob') return warn('branch-reference', `file exists in explicitly named branch ${branch[1]}`);
  }
  // The annotation applies to this token alone; an adjacent unqualified claim is
  // independently checked. Do not infer history from a whole prompt or section.
  const historical = new RegExp(`(?<![\\p{L}\\p{N}_])(?:Historical citation \\(aborted round\\)|\\u0418\\u0441\\u0442\\u043e\\u0440\\u0438\\u0447\\u0435\\u0441\\u043a\\u0430\\u044f \\u0441\\u0441\\u044b\\u043b\\u043a\\u0430 \\(\\u043f\\u0440\\u0435\\u0440\\u0432\\u0430\\u043d\\u043d\\u044b\\u0439 \\u0440\\u0430\\u0443\\u043d\\u0434\\)):\\s*\x60?${escape(c.token)}\x60?(?=[\\s.,;]|$)`, 'iu');
  const history = historical.exec(source);
  if (!c.lines && history && history.index + history[0].lastIndexOf(c.token) === c.col - 1) return warn('aborted-round', 'explicit historical citation of an aborted round');
  if (selected.hits.length > 1) {
    const valid = selected.hits.filter(target => resolvePath(target, c.lines).outcome === 'resolved');
    if (valid.length) return warn('ambiguous-short-path', `${selected.hits.length} repository files match (${valid.length} with valid line bounds); spell out the target`);
  }
  return strict;
}

module.exports = { calibrateCitation, archiveWarning };
