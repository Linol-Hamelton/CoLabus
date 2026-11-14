'use strict';
// One folding rule for maker names, shared by every reader that compares a maker spelling.

// The spellings of a maker name: the name without its parenthesized parts and each parenthesized alias, each as its
// lowercase words of letters and digits ("Zhipu AI (Z.ai)" gives zhipu ai and z ai).
function makerSpellings(name) {
  const text = String(name || '');
  const aliases = [...text.matchAll(/\(([^()]*)\)/g)].map(m => m[1]);
  return [text.replace(/\([^()]*\)/g, ' '), ...aliases].map(s => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(words => words.length);
}
// Two maker names match when one spelling of either is a whole-word prefix of one spelling of the other: the
// legal name, an abbreviation of it ("Zhipu") and an alias ("Z.ai") all match; another word ("Meta", "Metaphor") never
// does. Readers use it to restrict or exclude, so a match that is too wide only restricts more, never opens eligibility.
function makerMatches(a, b) {
  const prefix = (x, y) => x.length <= y.length && x.every((w, i) => w === y[i]);
  const left = makerSpellings(a), right = makerSpellings(b);
  return left.some(x => right.some(y => prefix(x, y) || prefix(y, x)));
}

module.exports = { makerSpellings, makerMatches };
