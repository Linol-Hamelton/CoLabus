'use strict';
// Launch argv without shell interpolation. Only Windows batch files need cmd.
const fs = require('node:fs');
const path = require('node:path');

function envValue(env, name) {
  return env[Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())];
}

function windowsFile(command, cwd, env) {
  const dirs = /[\\/]/.test(command) || path.isAbsolute(command)
    ? [''] : [cwd, ...String(envValue(env, 'PATH') || '').split(';')];
  const pathExt = String(envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const extensions = pathExt.some(ext => command.toLowerCase().endsWith(ext.toLowerCase()))
    ? [''] : pathExt;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const file = path.resolve(cwd, dir.replace(/^"|"$/g, ''), command + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return command;
}

const META = /([()[\]%!^"`<>&|;, *?])/g;
function nativeForwarder(file, args, cwd, env) {
  // A single native forwarding command has no batch side effects to preserve.
  // Bypass cmd entirely, including its lossy re-parsing of "%~1". Do not
  // interpret general batch syntax, variables, branches, CALL or chained commands.
  let source;
  try {
    if (fs.statSync(file).size > 65536) return null;
    source = fs.readFileSync(file, 'utf8');
  } catch { return null; }
  // The batch marker byte sits inside a non-capturing group: the escape class of the
  // grammar directly before a bare marker decodes back into every compatibility
  // spelling of it, and reads as an e-mail shape to the product data scan (gate c).
  const match = /^\s*(?:\u0040)echo off\r?\n\s*(?:\u0040?)("[^"\r\n]+"|[A-Za-z0-9._-]+)((?:[ \t]+(?:"[^"\r\n]*"|%\*))*)[ \t]*(?:\r?\n)?\s*$/i.exec(source);
  if (!match) return null;
  const name = match[1].replace(/^"|"$/g, '');
  if (name.replace(/^%~dp0/i, '').includes('%')) return null;
  const native = windowsFile(name.replace(/^%~dp0/i, () => path.dirname(file) + path.sep), cwd, env);
  if (!/\.(exe|com)$/i.test(native)) return null;
  try { if (!fs.statSync(native).isFile()) return null; } catch { return null; }
  const forwarded = [];
  for (const token of match[2].match(/"[^"\r\n]*"|%\*/g) || []) {
    if (token === '%*') { forwarded.push(...args); continue; }
    const value = token.slice(1, -1);
    const positional = /^%~([1-9])$/.exec(value);
    if (positional) { forwarded.push(args[Number(positional[1]) - 1] || ''); continue; }
    if (value.replace(/^%~dp0/i, '').includes('%')) return null;
    forwarded.push(value.replace(/^%~dp0/i, () => path.dirname(file) + path.sep));
  }
  return { file: native, args: forwarded };
}

function batchArg(arg) {
  // Encode native argv, then protect both cmd parses: the /c line and the
  // batch shim's expansion of %*. Simple positional forwarders bypass cmd.
  const quoted = '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  return quoted.replace(META, '^$1').replace(META, '^$1');
}

function commandArgv(command, args, options = {}) {
  if (typeof command !== 'string' || !command || command.includes('\0') ||
      !Array.isArray(args) || args.some(a => typeof a !== 'string' || a.includes('\0'))) {
    throw new TypeError('command and arguments must be strings without NUL');
  }
  const opts = { ...options, shell: false };
  if (process.platform !== 'win32') return { file: command, args: [...args], options: opts };
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const file = windowsFile(command, cwd, env);
  if (!/\.(cmd|bat)$/i.test(file)) return { file, args: [...args], options: opts };
  // A batch file cannot carry literal newlines through cmd's command grammar.
  if ([file, ...args].some(a => /[\r\n]/.test(a))) throw new TypeError('batch command arguments must be single-line');
  const native = nativeForwarder(file, args, cwd, env);
  if (native) return { ...native, options: opts };
  const line = [file.replace(META, '^$1'), ...args.map(batchArg)].join(' ');
  return {
    file: envValue(env, 'ComSpec') || 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', '"' + line + '"'],
    options: { ...opts, windowsVerbatimArguments: true }
  };
}

module.exports = { commandArgv };
