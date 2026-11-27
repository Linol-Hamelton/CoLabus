'use strict';
// real-path.cjs - the real path of a local path on every local volume. CommonJS, no dependencies.
// Native first: fs.realpathSync.native answers on a volume that has a Mount Manager name, and its answer is
// returned unchanged. On a volume without that name (a RAM disk such as ImDisk) Windows cannot name an opened
// object and Node answers EISDIR for every path of the volume, files too; there the real path is found by a
// walk from the volume root that follows no link and names each segment by its identity.
//
// create({ fs, env, platform }) -> { realPathSync(p), physicalPathSync(p), followedPathSync(p), strategyOf(p), state(), learnCreated(p) }
//   The module exports one instance on node:fs and process.env; a caller that has its own fs (a test seam)
//   creates its own instance, so the seam reaches the real path too. The latch belongs to the instance.
//   forFs(io) -> the module instance for node:fs (or no io), else one instance per io object, kept while io lives:
//   a module that takes an fs argument calls forFs(io).realPathSync(p) where it called io.realpathSync.native(p).
//   V1  The strategy is chosen once per drive root and instance: the native real path of the root answers ->
//       native; it answers EISDIR and the root is a directory with a nonzero file number -> walk, latched with
//       the device of the root. Any other answer chooses nothing: the native call of the path answers as before.
//   V2  native: fs.realpathSync.native is called with the caller's own spelling; its result and its error are
//       returned unchanged. An EISDIR of one path on a native volume stays an error: one volume never mixes the
//       two strategies.
//   V3  walk: the volume root must still have the latched device (else EREALPATH_VOLUME). Every segment is read
//       with lstat, never followed: a symbolic link or a junction is refused (EREALPATH_LINK); an object whose
//       followed stat is another object than its lstat (a mount point or another redirecting reparse point) is
//       refused (EREALPATH_REPARSE); a file number 0 is refused (EREALPATH_IDENTITY). An lstat error (a missing
//       segment: ENOENT) is thrown as it is.
//   V4  The true name of each segment (its letter case, the long name of an 8.3 alias, a name that Windows trims
//       of a trailing dot or space) is the entry of the parent listing whose device, file number and link count
//       are those of the segment's lstat: the exact spelling first, then the same name in another case, then
//       every other entry. No such entry, or two of them, is refused (EREALPATH_NAME): unknown never becomes a
//       name. The answer is built from these names only.
//   V5  The answer has an upper-case drive letter and backslashes, as the native answer.
//   V7  A directory held by an exclusive handle (the pin of path-safe W1) cannot be listed (EBUSY, EPERM,
//       EACCES). Then the name of a segment in it is the name this instance proved for the same spelling under
//       the same parent (device and file number) by an earlier listing, or the name declared by learnCreated(p)
//       right after the caller created p with that spelling; it is held to the segment's device, file number and
//       link count. Without such a name the listing is tried again for a bounded time (the exclusive handle of
//       another process is held for one short check); a listing still refused then is refused with its error. The
//       instance keeps at most MAX_PROVEN names and drops the one proven or used longest ago, one at a time.
//   V6  PROTOCOL_REAL_PATH_WALK: unset, "", "1" or "on" -> on (the default); "0" or "off" -> off (every volume
//       native: a volume without a Mount Manager name stays unreadable); "force" -> the walk on every drive volume
//       (tests and measurement); any other value -> off, shown as invalid. state() shows the switch and the
//       latched volumes; the first EISDIR met while the switch is not on emits one process warning.
//   V8  physicalPathSync(p): the real path for a containment, root or identity decision about a path that may
//       not exist yet. Only a missing segment is looked past; an existing object without a provable real path
//       throws, so the caller refuses it (outside, not the same root, not a usable root) instead of judging its
//       spelling.
//   V9  followedPathSync(p): where p leads, for a caller that judges the place a link points to (an overlap, an
//       escape, an identity) and never for a guard that refuses links. Where realPathSync answers, its answer is
//       returned unchanged (on a native volume that is the native real path, which follows links). Where the walk
//       refuses a link (EREALPATH_LINK), the first link segment of the spelling is read (readlink, never followed by
//       an open), its target resolved against the link's directory, and the rest of the spelling joined to it; then
//       again, at most MAX_LINKS times (else ELOOP). Every other error is thrown as it is.
//   Only a Windows drive root (X:\) is walked; POSIX, UNC and device paths, and anything that is not a string,
//   are always native.
//   NOT guaranteed: an answer is true at the moment of each lstat; a path can change after it (the guards
//   prove identity on the opened handle). A reparse point that redirects nothing (a cloud placeholder, dedup)
//   is not detected, as on the native path. A name taken from V7 is the proven name of that very object, but a
//   rename of it in another letter case while its directory was busy is not seen.
const nodeFs = require('node:fs');
const path = require('node:path');

const W = path.win32;
const SWITCH = 'PROTOCOL_REAL_PATH_WALK';
const DRIVE_ROOT = /^[A-Za-z]:\\$/;

const BUSY = ['EBUSY', 'EPERM', 'EACCES'];
// V7: the pauses before a busy listing is tried again (about a quarter second in all).
const BUSY_WAITS_MS = [2, 5, 10, 20, 40, 80, 100];
const PAUSE = new Int32Array(new SharedArrayBuffer(4));
const MAX_PROVEN = 4096;
const MAX_LINKS = 8;

const show = s => JSON.stringify(String(s).slice(0, 80));
const refuse = (code, what) => Object.assign(new Error(`${code}: ${what}`), { code });
const sameObject = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink;

function switchState(env) {
  const v = env[SWITCH];
  if (v === undefined || v === '' || v === '1' || /^on$/i.test(v)) return 'on';
  if (v === '0' || /^off$/i.test(v)) return 'off';
  if (/^force$/i.test(v)) return 'force';
  return 'invalid';
}

function create({ fs = nodeFs, env = process.env, platform = process.platform } = {}) {
  const latched = new Map(); // mode|upper-case drive root -> { strategy, dev }
  let warned = false;
  const nativeOf = p => fs.realpathSync.native(p);
  const modeNow = () => (platform === 'win32' ? switchState(env) : 'off');

  // V1: the strategy of one drive root under one switch mode, chosen once.
  function strategyOfRoot(root, mode) {
    const k = `${mode}|${root.toUpperCase()}`;
    const known = latched.get(k);
    if (known) return known;
    let chosen = null;
    let eisdir = mode === 'force';
    if (!eisdir) {
      try { nativeOf(root); chosen = { strategy: 'native', dev: null }; } catch (e) { eisdir = Boolean(e && e.code === 'EISDIR'); }
    }
    if (chosen === null && eisdir) {
      let st = null;
      try { st = fs.lstatSync(root, { bigint: true }); } catch { /* chooses nothing */ }
      if (st && st.isDirectory() && !st.isSymbolicLink() && st.ino !== 0n) chosen = { strategy: 'walk', dev: st.dev };
    }
    if (chosen) latched.set(k, chosen);
    return chosen;
  }

  // The drive root of an absolute spelling of p, or null when p is never walked.
  function driveRootOf(p) {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) return null;
    const abs = W.resolve(p);
    const root = W.parse(abs).root;
    return DRIVE_ROOT.test(root) ? { abs, root } : null;
  }

  // V7: proven names, by parent identity and spelling. At MAX_PROVEN names the one proven or used longest ago goes, one at a
  // time: the name learned or proven last stays while the walk that needs it runs (a cache emptied whole lost the name of a
  // folder just created in a held directory, and the walk after the mkdir refused it).
  const proven = new Map();
  const provenKey = (parentSt, seg) => `${parentSt.dev}:${parentSt.ino}|${seg.toUpperCase()}`;
  const keep = (k, v) => {
    proven.delete(k);
    if (proven.size >= MAX_PROVEN) proven.delete(proven.keys().next().value);
    proven.set(k, v);
  };
  const prove = (parentSt, seg, name, st) => {
    keep(provenKey(parentSt, seg), { name, dev: st.dev, ino: st.ino, nlink: st.nlink });
    return name;
  };

  // V4: the name of the entry of dir (whose lstat is parentSt) that is the object st.
  function trueName(dir, parentSt, seg, st) {
    let names;
    for (let attempt = 0; names === undefined; attempt++) {
      try { names = fs.readdirSync(dir); } catch (e) {
        const busy = Boolean(e && BUSY.includes(e.code));
        const known = busy ? proven.get(provenKey(parentSt, seg)) : null;
        if (known && sameObject(known, st)) { keep(provenKey(parentSt, seg), known); return known.name; }
        if (!busy || attempt >= BUSY_WAITS_MS.length) throw e;
        Atomics.wait(PAUSE, 0, 0, BUSY_WAITS_MS[attempt]);
      }
    }
    return prove(parentSt, seg, nameIn(dir, names, seg, st), st);
  }

  function nameIn(dir, names, seg, st) {
    const isIt = name => {
      let e;
      try { e = fs.lstatSync(W.join(dir, name), { bigint: true }); } catch { return false; }
      return sameObject(e, st);
    };
    if (names.includes(seg) && isIt(seg)) return seg;
    const upper = seg.toUpperCase();
    const folded = names.filter(n => n !== seg && n.toUpperCase() === upper && isIt(n));
    if (folded.length === 1) return folded[0];
    if (folded.length > 1) throw refuse('EREALPATH_NAME', `two entries are the segment ${show(seg)}`);
    const alias = names.filter(n => n !== seg && n.toUpperCase() !== upper && isIt(n));
    if (alias.length === 1) return alias[0];
    throw refuse('EREALPATH_NAME', alias.length ? `two entries are the segment ${show(seg)}` : `no entry of its directory is the segment ${show(seg)}`);
  }

  // V3, V4, V5: the walk from the volume root.
  function walk(abs, root, latch) {
    const top = fs.lstatSync(root, { bigint: true });
    if (top.dev !== latch.dev || !top.isDirectory() || top.isSymbolicLink()) throw refuse('EREALPATH_VOLUME', 'the volume root is not the latched volume');
    let cur = root.toUpperCase();
    let parentSt = top;
    for (const seg of abs.slice(root.length).split('\\').filter(s => s !== '')) {
      const next = W.join(cur, seg);
      const st = fs.lstatSync(next, { bigint: true });
      if (st.isSymbolicLink()) throw refuse('EREALPATH_LINK', `the segment ${show(seg)} is a symbolic link or junction`);
      const followed = fs.statSync(next, { bigint: true });
      if (followed.dev !== st.dev || followed.ino !== st.ino) throw refuse('EREALPATH_REPARSE', `the segment ${show(seg)} redirects (mount point or reparse point)`);
      if (st.ino === 0n) throw refuse('EREALPATH_IDENTITY', `the segment ${show(seg)} has no file number`);
      cur = W.join(cur, trueName(cur, parentSt, seg, st));
      parentSt = st;
    }
    return cur;
  }

  // V7: p was just created by the caller with this spelling below a walked real directory: its last segment is
  // its name. Nothing is learned on a native volume or for a link.
  function learnCreated(p) {
    const d = driveRootOf(p);
    const latch = d && modeNow() !== 'off' && modeNow() !== 'invalid' ? strategyOfRoot(d.root, modeNow()) : null;
    if (!latch || latch.strategy !== 'walk') return false;
    const name = W.basename(d.abs);
    const parentSt = fs.lstatSync(W.dirname(d.abs), { bigint: true });
    const st = fs.lstatSync(d.abs, { bigint: true });
    if (st.isSymbolicLink() || parentSt.isSymbolicLink() || st.ino === 0n || name === '') return false;
    prove(parentSt, name, name, st);
    return true;
  }

  function realPathSync(p) {
    const mode = modeNow();
    if (mode === 'on' || mode === 'force') {
      const d = driveRootOf(p);
      const latch = d && strategyOfRoot(d.root, mode);
      if (latch && latch.strategy === 'walk') return walk(d.abs, d.root, latch);
      return nativeOf(p);
    }
    try { return nativeOf(p); } catch (e) {
      if (platform === 'win32' && e && e.code === 'EISDIR' && !warned) {
        warned = true;
        process.emitWarning(`the real-path walk is switched off (${SWITCH}=${JSON.stringify(String(env[SWITCH]).slice(0, 16))}): a volume without a Mount Manager name stays unreadable`, { code: 'REAL_PATH_WALK_OFF' });
      }
      throw e;
    }
  }

  // V8: the real path of p, or for a p that does not exist the real path of its nearest existing ancestor joined with
  // the missing rest. Only a segment whose lstat answers ENOENT or ENOTDIR is looked past; an object that exists but
  // whose real path cannot be proven (a link to a volume without a Mount Manager name, a link the walk refuses, a
  // dangling link, an unreadable entry) throws the real-path error: its spelling never stands in for its target.
  function physicalPathSync(p) {
    let probe = path.resolve(p);
    const rest = [];
    for (;;) {
      try { return path.join(realPathSync(probe), ...rest.reverse()); } catch (error) {
        let exists = true;
        try { fs.lstatSync(probe); } catch (missing) { exists = !(missing && (missing.code === 'ENOENT' || missing.code === 'ENOTDIR')); }
        if (exists) throw error;
      }
      const up = path.dirname(probe);
      if (up === probe) return path.resolve(p);
      rest.push(path.basename(probe));
      probe = up;
    }
  }

  // V9: the real path of where p leads, links read on the way where the walk refuses them.
  function followedPathSync(p) {
    let at = p;
    for (let links = 0; ; links++) {
      try { return realPathSync(at); } catch (e) {
        if (!e || e.code !== 'EREALPATH_LINK') throw e;
        if (links >= MAX_LINKS) throw refuse('ELOOP', `more than ${MAX_LINKS} links on the way of ${show(p)}`);
        const abs = W.resolve(at);
        const root = W.parse(abs).root;
        const segs = abs.slice(root.length).split('\\').filter(s => s !== '');
        let link = null;
        for (let i = 1; i <= segs.length && link === null; i++) {
          const prefix = W.join(root, ...segs.slice(0, i));
          if (fs.lstatSync(prefix).isSymbolicLink()) link = { prefix, rest: segs.slice(i) };
        }
        if (link === null) throw e;
        at = W.join(W.resolve(W.dirname(link.prefix), fs.readlinkSync(link.prefix)), ...link.rest);
      }
    }
  }

  // 'walk' or 'native' for the volume of p under the switch as it is now, or null when nothing is chosen.
  function strategyOf(p) {
    const mode = modeNow();
    if (mode !== 'on' && mode !== 'force') return 'native';
    const d = driveRootOf(p);
    if (!d) return 'native';
    const latch = strategyOfRoot(d.root, mode);
    return latch ? latch.strategy : null;
  }

  function state() {
    const volumes = {};
    for (const [k, v] of latched) volumes[k] = v.strategy;
    return { variable: SWITCH, switch: modeNow(), offWarned: warned, volumes };
  }

  return { realPathSync, physicalPathSync, followedPathSync, strategyOf, state, learnCreated };
}

const shared = create();
const seams = new WeakMap();

function forFs(io) {
  if (io === undefined || io === null || io === nodeFs) return shared;
  let known = seams.get(io);
  if (!known) { known = create({ fs: io }); seams.set(io, known); }
  return known;
}

module.exports = { create, forFs, ...shared, SWITCH };
