'use strict';
// Use the actual JavaScript parser shipped with Node, without executing the
// inspected source or downloading a parser. Unsupported Node builds fail closed.
const Module = require('node:module');
let parser;
function parse(source) {
  if (!parser) {
    const builtin = 'internal/deps/acorn/acorn/dist/acorn';
    const implementation = process.binding('natives')[builtin];
    if (typeof implementation !== 'string') throw Error('reason-parser-unavailable');
    const module = new Module(builtin);
    module._compile(implementation, builtin);
    parser = module.exports;
  }
  try { return parser.parse(source, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true }); }
  catch (error) { throw Error(`reason-source-invalid:${error.message}`); }
}
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
// Binding targets of a pattern as [name, value] pairs. A value is an AST node,
// null (unknown), the synthetic identifier `fail` (taken out under a static key
// that spells fail) or a KeyedFail marker: taken out under a computed key that
// calleeDescriptors decides later, with the resolver.
function patternTargets(pattern, via = null, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push([pattern.name, via]);
  else if (pattern.type === 'AssignmentPattern') {
    patternTargets(pattern.left, via, out);
    for (const [name] of patternTargets(pattern.left)) out.push([name, pattern.right]);
  } else if (pattern.type === 'RestElement') patternTargets(pattern.argument, null, out);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(element => patternTargets(element, null, out));
  else if (pattern.type === 'ObjectPattern') for (const property of pattern.properties) {
    if (property.type === 'RestElement') { patternTargets(property.argument, null, out); continue; }
    const name = property.computed ? null : (property.key.name ?? property.key.value);
    patternTargets(property.value, property.computed ? { type: 'KeyedFail', key: property.key }
      : name === 'fail' ? { type: 'Identifier', name: 'fail' } : null, out);
  }
  return out;
}
function patternIdentifiers(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === 'Identifier') out.push(pattern);
  else if (pattern.type === 'AssignmentPattern') patternIdentifiers(pattern.left, out);
  else if (pattern.type === 'RestElement') patternIdentifiers(pattern.argument, out);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(element => patternIdentifiers(element, out));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property => patternIdentifiers(property.type === 'RestElement' ? property.argument : property.value, out));
  return out;
}
function bindings(ast) {
  const scopes = new WeakMap();
  function visit(node, scope) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && scope) scope.names.set(node.id.name, [node]);
    if (node.type === 'Program' || node.type === 'BlockStatement' || /Function/.test(node.type)) {
      scope = { parent: scope, names: new Map(), functionScope: node.type === 'Program' || /Function/.test(node.type) };
      for (const param of node.params || []) for (const [name, value] of patternTargets(param)) scope.names.set(name, [...(scope.names.get(name) || []), value]);
    }
    scopes.set(node, scope);
    if (node.type === 'CatchClause' && node.param) for (const [name, value] of patternTargets(node.param)) scope.names.set(name, [...(scope.names.get(name) || []), value]);
    if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration') {
      const pattern = node.left.declarations[0].id;
      if (pattern.type === 'ArrayPattern') pattern.elements.forEach((id, index) => {
        if (id?.type === 'Identifier') scope.names.set(id.name, [{ type: 'IterationColumn', source: node.right, index }]);
      });
    }
    if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) {
      let target = scope;
      if (node.kind === 'var') while (target.parent && !target.functionScope) target = target.parent;
      if (declaration.id.type === 'Identifier') {
        const name = declaration.id.name, values = target.names.get(name) || [];
        values.push(declaration.init); target.names.set(name, values);
      } else if (['ObjectPattern', 'ArrayPattern'].includes(declaration.id.type)) {
        // An array pattern keeps the iteration-column binding made above: only
        // targets with a known value (a default, a fail key) are added to it.
        for (const [name, value] of patternTargets(declaration.id)) {
          if (declaration.id.type === 'ArrayPattern' && value === null) continue;
          target.names.set(name, [...(target.names.get(name) || []), value]);
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, scope));
      else if (value && typeof value === 'object') visit(value, scope);
    }
  }
  visit(ast, null);
  const resolve = node => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.names.has(node.name)) return scope.names.get(node.name);
    return [null];
  };
  // All assignments count conservatively; no control-flow execution is assumed.
  walk(ast, node => {
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier') {
      const values = resolve(node.left); values.push(node.operator === '=' ? node.right : null);
    }
    if (node.type === 'AssignmentExpression' && ['ObjectPattern', 'ArrayPattern'].includes(node.left.type)) {
      for (const [name, value] of patternTargets(node.left)) {
        for (let scope = scopes.get(node); scope; scope = scope.parent) if (scope.names.has(name)) { scope.names.get(name).push(value); break; }
      }
    }
  });
  return resolve;
}
function values(node, resolve, seen = new Set()) {
  const unknown = () => ({ values: [], unknown: true });
  const combine = (a, b) => ({ values: [...a.values, ...b.values], unknown: a.unknown || b.unknown });
  if (!node || seen.has(node)) return unknown();
  seen = new Set(seen).add(node);
  const read = value => values(value, resolve, seen);
  if (node.type === 'Literal') return { values: node.regex ? [] : [node.value], unknown: !!node.regex };
  if (node.type === 'Identifier' && resolve) return resolve(node).map(read).reduce(combine, { values: [], unknown: false });
  if (node.type === 'IterationColumn') {
    const arrays = node.source.type === 'Identifier' && resolve ? resolve(node.source) : [node.source];
    return arrays.flatMap(array => array?.type === 'ArrayExpression' ? array.elements.map(row => row?.type === 'ArrayExpression' ? row.elements[node.index] : null) : [null])
      .map(read).reduce(combine, { values: [], unknown: false });
  }
  if (node.type === 'TemplateLiteral') {
    let result = { values: [node.quasis[0].value.cooked], unknown: false };
    for (let i = 0; i < node.expressions.length; i++) {
      const parts = read(node.expressions[i]);
      result = { values: result.values.flatMap(value => parts.values.map(part => value + String(part) + node.quasis[i + 1].value.cooked)), unknown: result.unknown || parts.unknown };
      if (result.values.length > 4096) throw Error('reason-expression-too-large');
    }
    return result;
  }
  if (node.type === 'ConditionalExpression') return combine(read(node.consequent), read(node.alternate));
  if (node.type === 'LogicalExpression') return combine(read(node.left), read(node.right));
  if (node.type === 'SequenceExpression') return read(node.expressions.at(-1));
  if (node.type === 'ChainExpression') return read(node.expression);
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = read(node.left), b = read(node.right);
    return { values: a.values.flatMap(left => b.values.map(right => left + right)), unknown: a.unknown || b.unknown };
  }
  return unknown();
}
function strings(node, resolve) { return values(node, resolve).values.filter(value => typeof value === 'string'); }
function memberName(node, resolve) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'ChainExpression') return memberName(node.expression, resolve);
  if (node.type === 'MemberExpression') return node.computed ? strings(node.property, resolve)[0] : node.property.name;
  return null;
}
// Callable analysis. calleeDescriptors answers: if this expression is called,
// can the callee be the refusal function, and with which arguments already
// bound ({ bound } from F.bind(thisArg, ...bound))? unknown = the callee may
// be fail but the analysis cannot read the arguments. Every wrapper that only
// forwards a value (sequence, conditional, logical, chain) is read through, and
// every alias is followed; anything else is no descriptor.
function isMethod(member, name, resolve) {
  return member.computed ? values(member.property, resolve).values.includes(name) : member.property.name === name;
}
function calleeDescriptors(node, resolve, seen = new Set()) {
  if (!node || seen.has(node)) return [];
  seen = new Set(seen).add(node);
  const same = child => calleeDescriptors(child, resolve, seen);
  if (node.type === 'ChainExpression') return same(node.expression);
  if (node.type === 'SequenceExpression') return same(node.expressions.at(-1));
  if (node.type === 'ConditionalExpression') return [...same(node.consequent), ...same(node.alternate)];
  if (node.type === 'LogicalExpression') return [...same(node.left), ...same(node.right)];
  if (node.type === 'Identifier') {
    if (node.name === 'fail') return [{ bound: [] }];
    return resolve(node).flatMap(value => {
      if (value?.type !== 'KeyedFail') return same(value);
      const key = values(value.key, resolve);
      return key.values.includes('fail') ? [{ bound: [] }] : key.unknown ? [{ bound: [], unknown: true }] : [];
    });
  }
  if (node.type === 'MemberExpression') {
    if (CHECK_DYNAMIC_EXECUTION && node.object.type === 'CallExpression' && isMethod(node, 'value', resolve)
      && memberName(node.object.callee, resolve) === 'getOwnPropertyDescriptor') {
      const key = values(node.object.arguments[1], resolve);
      return key.values.includes('fail') ? [{ bound: [] }] : key.unknown ? [{bound:[],unknown:true}] : [];
    }
    if (!node.computed) return node.property.name === 'fail' ? [{ bound: [] }] : [];
    const key=values(node.property, resolve);
    return key.values.includes('fail') ? [{ bound: [] }] : CHECK_DYNAMIC_EXECUTION && key.unknown ? [{bound:[],unknown:true}] : [];
  }
  if (CHECK_DYNAMIC_EXECUTION && node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
    && node.callee.object.name === 'Reflect' && isMethod(node.callee, 'get', resolve)) {
    const key=values(node.arguments[1],resolve);
    return key.values.includes('fail') ? [{bound:[]}] : key.unknown ? [{bound:[],unknown:true}] : [];
  }
  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && isMethod(node.callee, 'bind', resolve)) {
    return same(node.callee.object).map(d => ({ bound: [...d.bound, ...node.arguments.slice(1)],
      unknown: d.unknown || node.arguments.some(argument => argument.type === 'SpreadElement') }));
  }
  return [];
}
// Walk with the chain of ancestors; a non-computed property or key is a name,
// never a reference.
function traverse(node, parents, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  parents.push(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'key' && !node.computed && ['Property', 'MethodDefinition', 'PropertyDefinition'].includes(node.type)) continue;
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
    if (Array.isArray(value)) value.forEach(child => traverse(child, parents, visit));
    else if (value && typeof value === 'object') traverse(value, parents, visit);
  }
  parents.pop();
}
// Positions where an identifier is bound or assigned, never read.
function writePositions(ast) {
  const written = new Set();
  walk(ast, node => {
    if (node.type === 'VariableDeclarator') patternIdentifiers(node.id).forEach(id => written.add(id));
    if (/Function/.test(node.type)) { if (node.id) written.add(node.id); for (const param of node.params) patternIdentifiers(param).forEach(id => written.add(id)); }
    if (node.type === 'CatchClause' && node.param) patternIdentifiers(node.param).forEach(id => written.add(id));
    if (node.type === 'AssignmentExpression') { written.add(node.left); patternIdentifiers(node.left).forEach(id => written.add(id)); }
    if (node.type === 'UpdateExpression') written.add(node.argument);
  });
  return written;
}
// A value that is the refusal function may flow only where its use is a call,
// a call/apply/bind of it, an alias (which the resolver follows) or the
// export/context property named fail. Any other flow (argument, array element,
// object under another key, return value) hides later calls: the reference is
// reported as an unresolved site instead of being guessed at.
function escapes(ast, resolve) {
  const written = writePositions(ast), found = [];
  traverse(ast, [], (node, parents) => {
    if (!['Identifier', 'MemberExpression', 'CallExpression'].includes(node.type) || written.has(node)) return;
    // An unknown property *read* is data. Unknown member invocations are
    // inventoried by failCalls; reading an array or map is not itself a call.
    if (node.type==='MemberExpression' && node.computed && values(node.property,resolve).unknown
      && !values(node.property,resolve).values.includes('fail')) return;
    const descriptors=calleeDescriptors(node, resolve);
    if (!descriptors.length) return;
    if (descriptors.every(d=>d.unknown) && node.type==='Identifier'
      && !resolve(node).some(v=>v?.type==='KeyedFail')) return;
    let child = node, parent = null, index = parents.length - 1;
    for (; index >= 0; index--) {
      parent = parents[index];
      if (parent.type === 'ChainExpression' || parent.type === 'LogicalExpression') { child = parent; continue; }
      if (parent.type === 'SequenceExpression') { if (parent.expressions.at(-1) !== child) return; child = parent; continue; }
      if (parent.type === 'ConditionalExpression') { if (parent.test === child) return; child = parent; continue; }
      break;
    }
    if (index < 0) { found.push(node); return; }
    const grand = parents[index - 1];
    let accepted = false;
    if (parent.type === 'ExpressionStatement') accepted = true;
    else if (parent.type === 'CallExpression') accepted = parent.callee === child;
    else if (parent.type === 'MemberExpression') accepted = parent.object === child && grand?.type === 'CallExpression' && grand.callee === parent
      && ['call', 'apply', 'bind'].some(name => isMethod(parent, name, resolve));
    else if (parent.type === 'VariableDeclarator') accepted = parent.init === child && parent.id.type === 'Identifier';
    else if (parent.type === 'AssignmentExpression') accepted = parent.right === child && (parent.left.type === 'Identifier'
      || parent.left.type === 'MemberExpression' && !parent.left.computed && parent.left.property.name === 'fail');
    else if (parent.type === 'Property') accepted = parent.value === child && !parent.computed && (parent.key.name ?? parent.key.value) === 'fail';
    else if (parent.type === 'AssignmentPattern') accepted = parent.right === child && parent.left.type === 'Identifier';
    else if (parent.type === 'UnaryExpression') accepted = ['typeof', 'void', '!'].includes(parent.operator);
    else if (['IfStatement', 'WhileStatement', 'DoWhileStatement'].includes(parent.type)) accepted = parent.test === child;
    if (!accepted) found.push(node);
  });
  return found;
}
const CHECK_DYNAMIC_EXECUTION = true;
function failCalls(ast) {
  const result = [], resolve = bindings(ast), seen = new Set();
  // A site is a call-like node whose arguments[0] is the refusal reason. A
  // direct call is the node itself; call/apply/bind forms are views with the
  // effective arguments; an unreadable form gets itself as the only argument,
  // which the value reader reports as unknown.
  const site = (call, args, unknown) => {
    const list = unknown ? [call] : args;
    if (!list.length) return;
    const key = `${call.start}:${call.end}:${list[0].start}:${list[0].end}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(args === call.arguments && !unknown ? call : { type: 'CallExpression', start: call.start, end: call.end, callee: call.callee, arguments: list, synthetic: true });
  };
  walk(ast, node => {
    if (CHECK_DYNAMIC_EXECUTION && ['CallExpression','NewExpression'].includes(node.type)) {
      const dynamic = (target,seen=new Set()) => {
        if (!target || seen.has(target)) return false;
        seen=new Set(seen).add(target);
        if (target.type === 'Identifier') return ['eval','Function'].includes(target.name) || resolve(target).some(v=>dynamic(v,seen));
        return target.type === 'MemberExpression' && ['eval','Function'].includes(memberName(target,resolve));
      };
      if (dynamic(node.callee)) site(node,[],true);
    }
    if (node.type !== 'CallExpression') return;
    const callee = node.callee, spread = node.arguments.some(argument => argument.type === 'SpreadElement');
    if (callee.type === 'MemberExpression') for (const name of ['call', 'apply']) if (isMethod(callee, name, resolve)) {
      for (const d of calleeDescriptors(callee.object, resolve)) {
        if (name === 'call') site(node, [...d.bound, ...node.arguments.slice(1)], d.unknown || spread);
        else {
          const list = node.arguments[1];
          const known = list === undefined || list.type === 'ArrayExpression' && list.elements.every(element => element && element.type !== 'SpreadElement');
          site(node, [...d.bound, ...(list && known ? list.elements : [])], d.unknown || !known || spread && node.arguments[0].type === 'SpreadElement' || node.arguments.length > 2);
        }
      }
    }
    for (const d of calleeDescriptors(callee, resolve)) site(node, d.bound.length ? [...d.bound, ...node.arguments] : node.arguments, d.unknown);
  });
  for (const reference of escapes(ast, resolve)) site(reference, [], true);
  return result.sort((a, b) => a.start - b.start || a.end - b.end);
}
function refusalStrings(ast) { const resolve = bindings(ast); return failCalls(ast).flatMap(node => strings(node.arguments[0], resolve)); }
function unresolvedCalls(ast) { const resolve = bindings(ast); return failCalls(ast).filter(node => values(node.arguments[0], resolve).unknown); }
function producerStrings(ast) {
  const result = [], resolve = bindings(ast);
  walk(ast, node => {
    let value;
    if (node.type === 'Property' && (node.computed ? strings(node.key, resolve).includes('reason') : (node.key.name || node.key.value) === 'reason')) value = node.value;
    if (node.type === 'AssignmentExpression' && (node.left.type === 'MemberExpression' && node.left.computed
      ? strings(node.left.property, resolve).includes('reason') : memberName(node.left, resolve) === 'reason')) value = node.right;
    if (node.type === 'VariableDeclarator' && memberName(node.id) === 'reason') value = node.init;
    if (value) result.push(...strings(value, resolve));
    // RESULT is a text protocol. Its decoded string content, not JavaScript
    // spelling, supplies a constant reason. Templates may surround it with vars.
    const fragments = node.type === 'TemplateElement' ? [node.value.cooked] : node.type === 'Literal' ? strings(node) : [];
    for (const fragment of fragments) for (const match of (fragment || '').matchAll(/\breason=([A-Za-z][A-Za-z0-9_:-]*)(?=\s|$)/g)) result.push(match[1]);
  });
  return result;
}
// ---- executable evidence ----
// A covered-by justification is proof only when the named test can actually
// execute an assertion that compares something computed with the reason.
// Mentions in code that cannot run (a false branch, a statement after return,
// a function nobody references, an empty loop) or in an assertion whose checked
// arguments are all constants (a tautology) are no evidence.
const UNKNOWN = Symbol('unknown');
function evaluate(node, resolve, seen = new Set()) {
  if (!node || seen.has(node)) return UNKNOWN;
  seen = new Set(seen).add(node);
  const ev = child => evaluate(child, resolve, seen);
  switch (node.type) {
    case 'Literal': return node.regex ? {} : node.value;
    case 'TemplateLiteral': {
      let out = node.quasis[0].value.cooked;
      for (let i = 0; i < node.expressions.length; i++) {
        const value = ev(node.expressions[i]);
        if (value === UNKNOWN || (typeof value === 'object' && value !== null)) return UNKNOWN;
        out += String(value) + node.quasis[i + 1].value.cooked;
      }
      return out;
    }
    case 'Identifier': {
      if (node.name === 'undefined') return undefined;
      if (node.name === 'NaN') return NaN;
      if (node.name === 'Infinity') return Infinity;
      const found = resolve ? resolve(node) : [];
      if (!found.length) return UNKNOWN;
      const results = found.map(value => value ? ev(value) : UNKNOWN);
      return results.every(value => value !== UNKNOWN && Object.is(value, results[0])) ? results[0] : UNKNOWN;
    }
    case 'UnaryExpression': {
      const value = ev(node.argument);
      if (value === UNKNOWN) return UNKNOWN;
      return { '!': () => !value, '-': () => -value, '+': () => +value, void: () => undefined, typeof: () => typeof value }[node.operator]?.() ?? UNKNOWN;
    }
    case 'BinaryExpression': {
      const a = ev(node.left), b = ev(node.right);
      if (a === UNKNOWN || b === UNKNOWN || [a, b].some(value => typeof value === 'object' && value !== null)) return UNKNOWN;
      const table = { '+': () => a + b, '-': () => a - b, '*': () => a * b, '==': () => a == b, '!=': () => a != b, '===': () => a === b, '!==': () => a !== b, '<': () => a < b, '<=': () => a <= b, '>': () => a > b, '>=': () => a >= b };
      try { return table[node.operator]?.() ?? UNKNOWN; } catch { return UNKNOWN; }
    }
    case 'LogicalExpression': {
      const left = ev(node.left);
      if (left === UNKNOWN) return UNKNOWN;
      if (node.operator === '&&') return left ? ev(node.right) : left;
      if (node.operator === '||') return left ? left : ev(node.right);
      return left ?? ev(node.right);
    }
    case 'ConditionalExpression': {
      const test = ev(node.test);
      return test === UNKNOWN ? UNKNOWN : test ? ev(node.consequent) : ev(node.alternate);
    }
    case 'ArrayExpression': case 'ObjectExpression': case 'FunctionExpression': case 'ArrowFunctionExpression': return {};
    default: return UNKNOWN;
  }
}
const truth = (node, resolve) => { const value = evaluate(node, resolve); return value === UNKNOWN ? null : Boolean(value); };
// A value that cannot depend on anything the product code computes.
function constant(node, resolve, seen = new Set()) {
  if (!node || seen.has(node)) return false;
  seen = new Set(seen).add(node);
  const every = list => list.every(child => child && child.type !== 'SpreadElement' && constant(child, resolve, seen));
  switch (node.type) {
    case 'Literal': return true;
    case 'TemplateLiteral': return every(node.expressions);
    case 'Identifier': {
      if (['undefined', 'NaN', 'Infinity'].includes(node.name)) return true;
      const found = resolve ? resolve(node) : [];
      return found.length > 0 && found.every(value => value && constant(value, resolve, seen));
    }
    case 'UnaryExpression': return node.operator !== 'delete' && constant(node.argument, resolve, seen);
    case 'BinaryExpression': case 'LogicalExpression': return every([node.left, node.right]);
    case 'ConditionalExpression': return every([node.test, node.consequent, node.alternate]);
    case 'ArrayExpression': return every(node.elements);
    case 'ObjectExpression': return node.properties.every(property => property.type === 'Property' && (!property.computed || constant(property.key, resolve, seen)) && constant(property.value, resolve, seen));
    default: return false;
  }
}
const ends = (statement, resolve) => {
  if (!statement) return false;
  if (['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(statement.type)) return true;
  if (statement.type === 'BlockStatement') return statement.body.some(child => ends(child, resolve));
  if (statement.type === 'IfStatement') {
    const test = truth(statement.test, resolve);
    return test === true ? ends(statement.consequent, resolve) : test === false ? ends(statement.alternate, resolve)
      : Boolean(statement.alternate) && ends(statement.consequent, resolve) && ends(statement.alternate, resolve);
  }
  if (statement.type === 'TryStatement') return ends(statement.finalizer,resolve)
    || ends(statement.block,resolve) && (!statement.handler || ends(statement.handler.body,resolve));
  if (statement.type === 'ExpressionStatement' && statement.expression.type === 'CallExpression') {
    const call=statement.expression;
    return call.callee.type==='MemberExpression' && call.callee.object.name==='process' && ['exit','abort'].includes(memberName(call.callee,resolve));
  }
  return false;
};
// The set of nodes under root that can execute. A function bound to a name
// (a declaration, or a variable or assignment holding a function) runs only
// when that name is referenced by code that itself can run; every other
// function expression (an argument, an immediately invoked one, a returned one)
// is assumed to run. Names are matched without scope analysis: a shadowing
// name can only make a function look live, never hide live code.
const STRICT_EXECUTION = true;
function liveNodes(root, resolve) {
  if (!STRICT_EXECUTION) {const all=new Set();walk(root,n=>all.add(n));return all;}
  const live = new Set(), pending = new Map(), referenced = new Set(), started = new Set();
  const isFunction = node => node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
  const bind = (name, fn) => { if (!pending.has(fn)) pending.set(fn, []); pending.get(fn).push(fn); };
  const callFunction = fn => { if (isFunction(fn)) { referenced.add(fn); bind(null,fn); } };
  const body = fn => visit(fn.body);
  function statements(list) {
    for (const statement of list) if (statement.type === 'FunctionDeclaration') bind(statement.id.name, statement);
    for (const statement of list) { visit(statement); if (ends(statement, resolve)) break; }
  }
  function visit(node) {
    if (!node || typeof node.type !== 'string' || live.has(node)) return;
    live.add(node);
    switch (node.type) {
      case 'Program': return statements(node.body);
      case 'BlockStatement': return statements(node.body);
      case 'FunctionDeclaration': return;
      case 'FunctionExpression': case 'ArrowFunctionExpression': return;
      case 'VariableDeclarator':
        if (isFunction(node.init) && node.id.type === 'Identifier') bind(node.id.name, node.init); else visit(node.init);
        return;
      case 'AssignmentExpression':
        if (isFunction(node.right) && node.left.type === 'Identifier') bind(node.left.name, node.right); else {
          visit(node.left); visit(node.right);
          if(root.type==='Program' && node.left.type==='MemberExpression' && node.left.object.name==='module' && memberName(node.left)==='exports') {
            walk(node.right,child=>{if(child.type==='Identifier')resolve(child).forEach(callFunction);});
          }
        }
        return;
      case 'Identifier': return;
      case 'MemberExpression': visit(node.object); if (node.computed) visit(node.property); return;
      case 'Property': if (node.computed) visit(node.key); visit(node.value); return;
      case 'IfStatement': case 'ConditionalExpression': {
        const test = truth(node.test, resolve);
        visit(node.test);
        if (test !== false) visit(node.consequent);
        if (test !== true) visit(node.alternate);
        return;
      }
      case 'LogicalExpression': {
        const left = evaluate(node.left, resolve);
        visit(node.left);
        const skips = left !== UNKNOWN && (node.operator === '&&' ? !left : node.operator === '||' ? left : left !== null && left !== undefined);
        if (!skips) visit(node.right);
        return;
      }
      case 'WhileStatement': visit(node.test); if (truth(node.test, resolve) !== false) visit(node.body); return;
      case 'ForStatement': visit(node.init); visit(node.test); if (truth(node.test, resolve) !== false) { visit(node.body); visit(node.update); } return;
      case 'ForOfStatement': case 'ForInStatement': visit(node.right); if (!(node.right.type === 'ArrayExpression' && !node.right.elements.length)) visit(node.body); return;
      case 'TryStatement':
        // Exception control flow is not execution proof: a catch body may never
        // run. The normal path and finally are inspected, abrupt ends propagate.
        visit(node.block); visit(node.finalizer); return;
      case 'SwitchStatement': {
        visit(node.discriminant);
        const value=evaluate(node.discriminant,resolve);
        if(value===UNKNOWN)return;
        let start=node.cases.findIndex(c=>c.test && evaluate(c.test,resolve)===value);
        if(start<0)start=node.cases.findIndex(c=>!c.test);
        for(let i=start;i>=0 && i<node.cases.length;i++) {
          const branch=node.cases[i];statements(branch.consequent);
          if(branch.consequent.some(s=>ends(s,resolve)))break;
        }
        return;
      }
      case 'CallExpression': {
        // A callback handed to an iteration of an empty array literal never runs.
        const empty = node.callee.type === 'MemberExpression' && node.callee.object.type === 'ArrayExpression' && !node.callee.object.elements.length
          && ['forEach', 'map', 'filter', 'some', 'every', 'flatMap', 'reduce'].includes(node.callee.property.name);
        visit(node.callee);
        if(node.callee.type==='Identifier')resolve(node.callee).forEach(callFunction);
        else if(isFunction(node.callee))callFunction(node.callee);
        const name=memberName(node.callee,resolve);
        const callbacks=name==='test' || node.callee.type==='MemberExpression'
          && (['forEach','map','filter','some','every','flatMap','reduce'].includes(name)
            || node.callee.object.name==='assert' && ['throws','rejects','doesNotThrow','doesNotReject'].includes(name));
        for (const argument of node.arguments) if (!(empty && isFunction(argument))) {
          visit(argument);
          if(callbacks && isFunction(argument))callFunction(argument);
        }
        return;
      }
      default:
        for (const [key, value] of Object.entries(node)) {
          if (key === 'params') continue;
          if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
        }
    }
  }
  visit(root);
  for (let again = true; again;) {
    again = false;
    for (const [name, functions] of pending) if (referenced.has(name)) for (const fn of functions) if (!started.has(fn)) { started.add(fn); live.add(fn); body(fn); again = true; }
  }
  return live;
}
const SKIP_OPTION = ['skip', 'todo'];
function executableOptions(options,resolve) {
  if(!options)return true;
  if(options.type!=='ObjectExpression')return false;
  return options.properties.every(property=>{
    if(property.type!=='Property'||property.kind!=='init'||property.method)return false;
    const key=property.computed?values(property.key,resolve):{values:[property.key.name ?? property.key.value],unknown:false};
    return !key.unknown && key.values.length===1 && (!SKIP_OPTION.includes(key.values[0]) || truth(property.value,resolve)===false);
  });
}
function testCases(source) {
  const result = [], ast = parse(source), resolve = bindings(ast), live = liveNodes(ast, resolve);
  walk(ast, node => {
    if (!live.has(node) || node.type !== 'CallExpression' || memberName(node.callee) !== 'test') return;
    const names = strings(node.arguments[0]), callback = node.arguments.at(-1);
    if (names.length !== 1 || !['ArrowFunctionExpression', 'FunctionExpression'].includes(callback?.type)) return;
    // A skipped or todo test never executes its assertions.
    const options = node.arguments.length === 3 ? node.arguments[1] : null;
    if (STRICT_EXECUTION && !executableOptions(options,resolve)) return;
    const mentions = [], reachable = liveNodes(callback.body, resolve);
    walk(callback.body, child => {
      // Existing tests use assert.* or the refusal helpers whose named argument
      // is passed to their assertion. Loose literals/comments cannot certify.
      if (!reachable.has(child) || child.type !== 'CallExpression') return;
      const callee = child.callee;
      const asserted = callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'assert';
      const helper = callee.type === 'Identifier' && ['refuseRow', 'refuse', 'reject', 'expectRefusal', 'unchangedRefusal'].includes(callee.name);
      if (!asserted && !helper) return;
      const argumentsToCheck = asserted ? child.arguments.slice(0, ['ok', 'fail'].includes(memberName(callee)) ? 1 : 2) : child.arguments;
      // An assertion whose checked arguments are all constants compares nothing
      // the product computed: a tautology, not evidence.
      if (asserted && argumentsToCheck.every(argument => constant(argument, resolve))) return;
      for (const argument of argumentsToCheck) walk(argument, value => {
        if (value.type === 'Literal' && value.regex) mentions.push(value.regex.pattern);
        else if (value.type === 'Literal' || value.type === 'TemplateLiteral' || value.type === 'Identifier') mentions.push(...strings(value, resolve));
      });
    });
    result.push({ name: names[0], body: source.slice(callback.body.start, callback.body.end), mentions });
  });
  return result;
}
module.exports = { parse, walk, strings, memberName, failCalls, refusalStrings, unresolvedCalls, producerStrings, testCases, liveNodes, constant };
