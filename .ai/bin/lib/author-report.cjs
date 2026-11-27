'use strict';
// Package identity is case-insensitive. Preserve every dash and digit: never
// strip an ops- prefix, a round suffix or punctuation to make a lossy slug.
const fs = require('node:fs');
const path = require('node:path');
const { maskMarkdown } = require('./text-safe.cjs');
// One package id grammar for streams and report titles: segments of letters and digits joined by
// single dashes; a segment after the first may be a release version of digits joined by single dots,
// and a release version may carry one pre-release part (RELEASE-PATCH-2.0.3-pre.4: letters, a dot, digits).
const PACKAGE_ID = '[A-Za-z0-9]+(?:-(?:[0-9]+(?:\\.[0-9]+)+(?:-[A-Za-z]+\\.[0-9]+)?|[A-Za-z0-9]+))*';
function packageName(stream) {
  if (typeof stream !== 'string' || stream.length > 64 || !new RegExp(`^${PACKAGE_ID}$`).test(stream)) {
    throw new Error('AUTHOR-REPORT-STREAM: use a package id of letters, digits and single dashes, a release version of digits and single dots with at most one pre-release part such as -pre.4 (max 64)');
  }
  // The name is upper case; a pre-release part keeps the lower case of its release (RELEASE-PATCH-2.0.3-pre.4).
  return stream.toUpperCase().replace(/(-[0-9]+(?:\.[0-9]+)+)(-[A-Z]+\.[0-9]+)(?=-|$)/g, (_, version, pre) => `${version}${pre.toLowerCase()}`);
}
function reportPath(stream) { return `docs/ops/${packageName(stream)}-AUTHOR-REPORT.md`; }
function instruction(stream) {
  const name = packageName(stream);
  return `Author report: ${reportPath(stream)}\nWrite or update the package author report only at that path, with the first heading starting "# ${name}:". This package output path overrides copied output paths in the task text; references to earlier reports remain inputs. Never use the client, seat name or another package's path for this output.\nBefore handoff in the protocol source repository, run node .ai/bin/ops-tools/source/derived.cjs rebuild, review changed files and every REVIEW_PIN; reader-pins requires a human or certifier record via --pin-review followed by the path of the JSON review record written by a human or a certifier before accepting changed reader hashes; check mode only reports drift.\n`;
}
function titleProblem(file, text) {
  const match = /^(.+)-AUTHOR-REPORT\.md$/i.exec(path.basename(file));
  if (!match) return null;
  const expected = match[1].toUpperCase();
  // The first H1 is the report title; prose and later headings cannot rescue it.
  const line = maskMarkdown(text).lines.find(l => !l.masked && /^# +/.test(l.text));
  const heading = line && /^# +(.+)$/.exec(line.text);
  const token = heading && new RegExp(`^(?:\\*\\*|\`)?(${PACKAGE_ID})(?=\\*\\*|\`|\\s|:|[\\u2013\\u2014]|$)`).exec(heading[1]);
  if (!token) return `author report needs a package title starting ${expected}`;
  const actual = token[1].toUpperCase();
  return actual === expected ? null : `author report title package ${actual} differs from filename package ${expected}`;
}
function checkTitles(root, report) {
  const dir = path.join(root, 'docs', 'ops');
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) {
    if (e.code !== 'ENOENT') report('CM-76', 'WARN', 'author report directory is unreadable', 'docs/ops');
    return;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!/-AUTHOR-REPORT\.md$/i.test(entry.name)) continue;
    const relative = `docs/ops/${entry.name}`;
    if (!entry.isFile()) { report('CM-76', 'WARN', 'author report is not a regular file', relative); continue; }
    try {
      const problem = titleProblem(entry.name, fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (problem) report('CM-76', 'WARN', problem, relative);
    } catch { report('CM-76', 'WARN', 'author report is unreadable', relative); }
  }
}
module.exports = { packageName, reportPath, instruction, titleProblem, checkTitles };
