'use strict';
// One comparison alphabet for every root, worktree and report in this package.
// key() never throws: it returns {ok:true,key} or {ok:false,reason}. An unresolved
// path is UNKNOWN for its caller and no comparison involving one is ever true.
const fs=require('node:fs'),path=require('node:path'),realPath=require('../../.ai/bin/lib/real-path.cjs');
const unresolved=reason=>({ok:false,reason});
// no answer of this module depends on process.cwd(). A
// relative spelling resolves against the repository this package lives in, the same
// base for every root, worktree, target and option.
const BASE=path.resolve(__dirname,'../..');
// A local extended-length prefix names the
// same file as its plain path. Windows does not normalise a path under that prefix, so it is
// accepted only in its literal form: backslash separators, no '.' or '..' segment.
// Any other \\?\, \\.\ or UNC spelling stays unsupported (syntax below).
function local(value) {
  if(process.platform!=='win32' || typeof value!=='string')return value;
  const m=/^\\\\\?\\([A-Za-z]:\\[^]*)$/.exec(value);
  if(!m)return value;
  if(m[1].includes('/') || m[1].split('\\').some(s=>s==='.' || s==='..'))return null;
  return m[1];
}
function syntax(value) {
  if(typeof value!=='string' || !value || value.includes('\0'))return 'invalid-path';
  if(process.platform==='win32') {
    // UNC and device namespaces need the network or
    // a device driver to resolve; this package refuses them before any lookup.
    if(/^[\\/]{2}/.test(value))return 'unc-unsupported';
    // A drive-relative spelling depends on a per-drive cwd.
    if(/^[A-Za-z]:(?![\\/])/.test(value))return 'invalid-path';
    const rest=value.replace(/^[A-Za-z]:/,'');
    if(/[<>"|?*]/.test(rest))return 'invalid-path';
    // An NTFS alternate data stream (tree:ads, file::$DATA): any colon after the
    // drive prefix names a stream, never a directory.
    if(rest.includes(':'))return 'stream-unsupported';
    // A Windows device name in any segment, with or without an extension and with
    // the trailing dots and spaces Windows strips (NUL, nul.txt, COM1 , LPT9.log).
    for(const segment of rest.split(/[\\/]/)) {
      const stem=segment.split('.')[0].replace(/ +$/,'');
      if(/^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i.test(stem))return 'device-name';
    }
  }
  return null;
}
function realOf(absolute) {
  let real;
  try {real=(fs.realpathSync.native?realPath.realPathSync:fs.realpathSync)(absolute);}
  catch(e) {
    const parent=path.dirname(absolute);
    if(parent===absolute)return unresolved(e.code==='ENOENT'?'drive-not-mounted':'path-unreadable');
    if(!['ENOENT','ENOTDIR'].includes(e.code))return unresolved(e.code==='EINVAL'?'invalid-path':'path-unreadable');
    // only a segment that does not exist is looked past: a dangling link exists, and its spelling is not its target
    let exists=true;
    try {fs.lstatSync(absolute);} catch(missing) {exists=!['ENOENT','ENOTDIR'].includes(missing&&missing.code);}
    if(exists)return unresolved('path-unreadable');
    const up=realOf(parent);
    if(!up.ok)return up;
    real=path.join(up.real,path.basename(absolute));
  }
  return {ok:true,real};
}
function key(value) {
  value=local(value);if(value===null)return unresolved('invalid-path');
  const bad=syntax(value);if(bad)return unresolved(bad);
  let absolute;
  try {absolute=path.resolve(BASE,value.replace(/[\\/]/g,path.sep));}catch {return unresolved('invalid-path');}
  const found=realOf(absolute);if(!found.ok)return found;
  const real=found.real;
  const normalized=real.replace(/\\/g,'/'),root=path.parse(real).root.replace(/\\/g,'/');
  const unified=normalized.length>root.length ? normalized.replace(/\/+$/,''):normalized;
  return {ok:true,key:process.platform==='win32'?unified.toLowerCase():unified};
}
// a WORKTREE identity. key() names a file that may not exist yet (an
// archive target); a worktree is the real path of an EXISTING directory. A missing
// path, a missing drive and a file are unresolved, and a relative spelling resolves
// against base (the repository), never against the process cwd.
function tree(value,base) {
  const plain=local(value);if(plain===null)return unresolved('invalid-path');
  const bad=syntax(plain);if(bad)return unresolved(bad);
  let absolute,real;
  try {absolute=path.resolve(base||BASE,plain.replace(/[\\/]/g,path.sep));}catch {return unresolved('invalid-path');}
  try {real=(fs.realpathSync.native?realPath.realPathSync:fs.realpathSync)(absolute);}
  catch(e) {
    if(e.code!=='ENOENT' && e.code!=='ENOTDIR')return unresolved('path-unreadable');
    return unresolved(fs.existsSync(path.parse(absolute).root)?'worktree-missing':'drive-not-mounted');
  }
  try {if(!fs.statSync(real).isDirectory())return unresolved('worktree-not-directory');}catch {return unresolved('path-unreadable');}
  // the identity carries its one canonical spelling (the real path, no
  // extended prefix) beside the key, so a caller never keeps the spelling it was given.
  const k=key(real);
  return k.ok?{...k,real:real.replace(/^\\\\\?\\(?=[A-Za-z]:\\)/,'')}:k;
}
// A key inside (or equal to) a root key, at a path segment boundary.
const within=(rootKey,k)=>typeof rootKey==='string' && typeof k==='string' && (k===rootKey || k.startsWith(rootKey.endsWith('/')?rootKey:rootKey+'/'));
const same=(a,b)=>{const x=key(a),y=key(b);return x.ok && y.ok && x.key===y.key;};
const inside=(root,file)=>{const x=key(root),y=key(file);if(!x.ok || !y.ok)return false;const r=x.key,f=y.key;return f===r || f.startsWith(r.endsWith('/')?r:r+'/');};
module.exports={key,same,inside,tree,within};
