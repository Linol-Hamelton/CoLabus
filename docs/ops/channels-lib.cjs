'use strict';
// channels-lib: shared pieces of the channels kit (Class B tooling, docs/ops only).
// Catalog access, key naming, the credential-store interface (OS stores and a fake store), secret-value hygiene, leak scan.
// Hard rules kept here so every tool inherits them:
//   * a key VALUE is only ever read through store.get(), and only by channels-keys (never) and channels-env (child env only);
//     the doctor and the duplicate finder receive presenceView(store), which has no get();
//   * a value never enters argv, a log line, an error message or a file; values travel on stdin or in a child environment;
//   * the repository holds NAMES only.
// No third-party packages: Node built-ins, PowerShell (Windows), security (macOS), secret-tool (Linux).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// The leak scan reuses the SECRETS patterns of the launch-record validator (one list of secret shapes in the project).
const { secretIn } = require('../../.ai/bin/accounting/launch-record-validate.cjs');

const PREFIX = 'KEYSTORE_';
const SERVICE_RE = /^[A-Z0-9]+$/;
const ALIAS_RE = /^[A-Za-z][A-Za-z0-9]{0,23}$/;
const STORED_RE = /^KEYSTORE_([A-Z0-9]+)_([A-Z][A-Z0-9]{0,23})$/;
const KINDS = ['cli', 'api', 'mcp'];
const LOGIN_METHODS = ['browser-oauth', 'device-code', 'api-key', 'none'];
// Result of the plain GET of the vendor key page: ok 2xx, login-redirect (it sends you to a login page: it resolves),
// moved (redirect to another page), blocked (401/403: a login or bot check stands in front), unreachable, no-page (the key has no vendor page).
const KEY_CHECK_STATUSES = ['ok', 'login-redirect', 'moved', 'blocked', 'unreachable', 'no-page'];
const VERIFY_AUTH = ['bearer', 'url-token'];
const FAKE_STORE_ENV = 'CHANNELS_FAKE_STORE_FILE';
const ALLOW_FAKE_ENV = 'CHANNELS_ALLOW_FAKE_STORE';

// ---------------------------------------------------------------- catalog
function defaultCatalogPath() { return path.join(__dirname, 'channels-catalog.json'); }

function loadCatalog(file) {
  const p = file || defaultCatalogPath();
  const cat = JSON.parse(fs.readFileSync(p, 'utf8'));
  const problems = validateCatalog(cat);
  if (problems.length) throw new Error(`catalog ${p} is invalid: ${problems.join('; ')}`);
  return cat;
}

// Vendor page of a key: keyUrl (https or null), keyHint (one Russian line), keyChecked {date, how, status}.
function validateKeyPage(where, k) {
  const p = [];
  if (typeof k.keyHint !== 'string' || !k.keyHint.trim() || /[\r\n]/.test(k.keyHint)) p.push(`${where}: key.keyHint is required (one line)`);
  if (k.keyUrl === undefined) p.push(`${where}: key.keyUrl is required (an https page or null)`);
  else if (k.keyUrl !== null) {
    let u = null;
    try { u = new URL(k.keyUrl); } catch (e) { p.push(`${where}: key.keyUrl is not a URL`); }
    if (u && u.protocol !== 'https:') p.push(`${where}: key.keyUrl must be https`);
    else if (u && (u.username || u.password)) p.push(`${where}: key.keyUrl must not carry credentials`);
  }
  const kc = k.keyChecked;
  if (!kc || !/^\d{4}-\d{2}-\d{2}$/.test(kc.date || '') || typeof kc.how !== 'string' || !kc.how || !KEY_CHECK_STATUSES.includes(kc.status)) p.push(`${where}: key.keyChecked needs {date YYYY-MM-DD, how, status one of ${KEY_CHECK_STATUSES.join('/')}}`);
  else if (k.keyUrl === null && kc.status !== 'no-page') p.push(`${where}: key.keyChecked.status must be no-page when keyUrl is null`);
  else if (k.keyUrl && kc.status === 'no-page') p.push(`${where}: key.keyChecked.status no-page contradicts a keyUrl`);
  return p;
}

// Read-only authenticated endpoint of a key (channels-verify.cjs): one request, only to a host of the allow-list, https only.
function validateVerify(where, k) {
  const p = [];
  const v = k.verify;
  if (v === undefined || v === null) return p;
  if (!Array.isArray(v.hosts) || !v.hosts.length || !v.hosts.every(h => /^[a-z0-9][a-z0-9.-]*$/.test(h))) { p.push(`${where}: key.verify.hosts must list the vendor host(s)`); return p; }
  if (!VERIFY_AUTH.includes(v.auth)) p.push(`${where}: key.verify.auth must be one of ${VERIFY_AUTH.join('/')}`);
  if (typeof v.parse !== 'string' || !/^[a-z]+$/.test(v.parse)) p.push(`${where}: key.verify.parse must name a parser`);
  const hasPlaceholder = typeof v.url === 'string' && v.url.includes('<token>');
  if ((v.auth === 'url-token') !== hasPlaceholder) p.push(`${where}: the <token> placeholder belongs in key.verify.url exactly when auth is url-token`);
  let u = null;
  try { u = new URL(String(v.url).replace('<token>', 'TOKEN')); } catch (e) { p.push(`${where}: key.verify.url is not a URL`); }
  if (u && u.protocol !== 'https:') p.push(`${where}: key.verify.url must be https`);
  else if (u && (u.username || u.password)) p.push(`${where}: key.verify.url must not carry credentials`);
  else if (u && !v.hosts.includes(u.hostname)) p.push(`${where}: key.verify.url host ${u.hostname} is not in key.verify.hosts`);
  return p;
}

// What the user is shown about the vendor page of a key: { url, hint, status, usable, note }. An unreachable or missing page is NOT offered as working.
function keyPage(ch) {
  const k = ch.key || {};
  const kc = k.keyChecked || {};
  const url = k.keyUrl || null;
  const usable = !!url && kc.status !== 'unreachable' && kc.status !== 'no-page';
  let note = '';
  if (!url) note = 'no vendor page is recorded for this key';
  else if (kc.status === 'unreachable') note = `key page not confirmed: the check of ${kc.date} found it unreachable (${kc.how}); it is not offered as working`;
  else if (kc.status === 'blocked') note = `the check of ${kc.date} got 401 or 403 (a login or a bot check stands in front): confirm the page in a browser`;
  else if (kc.status === 'moved') note = `the check of ${kc.date} found the page moved: the vendor redirects to another page`;
  return { url, hint: k.keyHint || '', status: kc.status || null, usable, note };
}

// The lines shown before a key prompt: the page (when usable), the check note (when the page is not plain ok) and the hint.
function keyPageLines(ch, indent) {
  const kp = keyPage(ch);
  const pad = indent === undefined ? '  ' : indent;
  const out = [];
  if (kp.usable) out.push(`${pad}key page: ${kp.url}  (checked ${ch.key.keyChecked.date}: ${kp.status})`);
  if (kp.note && !(kp.usable && kp.status !== 'blocked' && kp.status !== 'moved')) out.push(`${pad}${kp.note}`);
  if (kp.hint) out.push(`${pad}hint: ${kp.hint}`);
  return out;
}

function isOffered(ch) { return ch.verified !== false && !ch.excluded; }
function findChannel(cat, id) { return cat.channels.find(c => c.id === id) || null; }
function channelByService(cat, service) { return cat.channels.find(c => c.key && c.key.service === service) || null; }

function validateCatalog(cat) {
  const problems = [];
  if (!cat || cat.schema !== 'channels-catalog/1') return ['schema must be channels-catalog/1'];
  if (!Array.isArray(cat.channels)) return ['channels must be an array'];
  const ids = new Set(); const services = new Set(); const envNames = new Map();
  const note = (name, owner) => {
    if (envNames.has(name) && envNames.get(name) !== owner) problems.push(`name ${name} is claimed by ${envNames.get(name)} and ${owner}`);
    envNames.set(name, owner);
  };
  for (const c of cat.channels) {
    const where = `channel ${c && c.id}`;
    if (!c || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) { problems.push(`${where}: bad id`); continue; }
    if (ids.has(c.id)) problems.push(`${where}: duplicate id`);
    ids.add(c.id);
    if (!KINDS.includes(c.kind)) problems.push(`${where}: kind must be one of ${KINDS.join(', ')}`);
    if (!c.login || !LOGIN_METHODS.includes(c.login.method)) problems.push(`${where}: login.method must be one of ${LOGIN_METHODS.join(', ')}`);
    if (typeof c.userAction !== 'string' || !c.userAction) problems.push(`${where}: userAction is required`);
    if (typeof c.evidence !== 'string' || !c.evidence) problems.push(`${where}: evidence is required (no fact without a source)`);
    if (c.unverifiedNote !== undefined && (typeof c.unverifiedNote !== 'string' || !c.unverifiedNote.trim())) problems.push(`${where}: unverifiedNote must be a non-empty text`);
    if (c.key) {
      const k = c.key;
      if (!SERVICE_RE.test(k.service || '')) problems.push(`${where}: key.service must match ${SERVICE_RE}`);
      else if (services.has(k.service)) problems.push(`${where}: key.service ${k.service} is used twice (one canonical key per service)`);
      else services.add(k.service);
      if (!/^[A-Z][A-Z0-9_]*$/.test(k.env || '')) problems.push(`${where}: key.env must be an upper-case variable name`);
      else note(k.env, c.id);
      for (const a of k.aliases || []) {
        if (!a || !/^[A-Z][A-Z0-9_]*$/.test(a.name || '')) problems.push(`${where}: bad alias ${JSON.stringify(a)}`);
        else note(a.name, c.id);
      }
      for (const u of k.usedBy || []) if (typeof u !== 'string' || u.includes('\\') || path.isAbsolute(u)) problems.push(`${where}: usedBy must be repo-relative with forward slashes`);
      if (!k.rotation || !k.expiry) problems.push(`${where}: key.rotation and key.expiry notes are required`);
      if (k.scope !== 'per-device') problems.push(`${where}: key.scope must be per-device`);
      problems.push(...validateKeyPage(where, k));
      for (const m of k.companions || []) if (!m || !/^[A-Z][A-Z0-9_]*$/.test(m.name || '') || m.secret !== false || typeof m.evidence !== 'string' || !m.evidence) problems.push(`${where}: companion ${m && m.name} needs an upper-case name, secret false (a secret belongs in the store) and evidence`);
      problems.push(...validateVerify(where, k));
      if (k.expectedBot !== undefined && !/^@[A-Za-z0-9_]{3,64}$/.test(k.expectedBot)) problems.push(`${where}: key.expectedBot must look like @name`);
      for (const a of k.aliases || []) for (const flag of ['inject', 'notKeystore']) if (a && a[flag] !== undefined && typeof a[flag] !== 'boolean') problems.push(`${where}: alias ${a.name} ${flag} must be true or false`);
    }
    for (const dep of c.needsKeys || []) if (!cat.channels.some(x => x.id === dep && x.key)) problems.push(`${where}: needsKeys ${dep} is not a channel with a key`);
    if (c.mandatory) {
      const k = c.connect;
      if (!k || typeof k.pin !== 'string' || !k.pin || typeof k.section !== 'string' || !k.target || !k.fragments) problems.push(`${where}: a mandatory MCP server needs connect {section, pin, target, fragments} (the doctor prints it)`);
      else for (const cl of ['claude', 'codex', 'vibe']) {
        if (!Array.isArray(k.fragments[cl]) || !k.fragments[cl].length || !k.fragments[cl].every(l => typeof l === 'string')) problems.push(`${where}: connect.fragments.${cl} must be a non-empty array of lines`);
        if (typeof k.target[cl] !== 'string' || !k.target[cl]) problems.push(`${where}: connect.target.${cl} is required`);
      }
    }
  }
  return problems;
}

// The path of a sibling tool as the user types it from `root`: in an installed project the kit lives under docs/ops/pilot-kit/src/, in the
// source repository at docs/ops/. A root that does not contain the tool (a fixture, another directory) gets the source-repository form.
function toolRel(name, root) {
  const rel = root ? path.relative(path.resolve(root), path.join(__dirname, name)) : '';
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : `docs/ops/${name}`;
}

// ---------------------------------------------------------------- naming
function storedName(service, alias) {
  if (!SERVICE_RE.test(service || '')) throw new Error('bad service name');
  if (!ALIAS_RE.test(alias || '')) throw new Error('bad alias (letters and digits, starts with a letter, at most 24 characters)');
  return `${PREFIX}${service}_${String(alias).toUpperCase()}`;
}
function parseStoredName(name) {
  const m = STORED_RE.exec(String(name));
  return m ? { service: m[1], alias: m[2] } : null;
}

// ---------------------------------------------------------------- value hygiene
// Reasons never contain the value. Printable ASCII, no spaces: real provider keys, tokens and connection strings fit.
function checkValue(v, platform) {
  if (typeof v !== 'string' || v.length === 0) return 'empty value';
  if (v.length < 8) return 'value is shorter than 8 characters (a real key is longer)';
  if (v.length > 1200) return 'value is longer than 1200 characters (the Windows store blob limit is 2560 bytes)';
  if (!/^[\x21-\x7e]+$/.test(v)) return 'value must be printable ASCII without spaces or control characters';
  if (platform === 'darwin' && /["\\]/.test(v)) return 'value contains a quote or backslash that the macOS path cannot pass safely';
  return null;
}

// Refuses any attempt to put a value on the command line. Returns a reason (never the argument) or null.
const VALUE_FLAG = /^--?(value|key|secret|token|password|passwd|pass|apikey|api-key|api_key|with-value|stdin-value|data)(=|$)/i;
function argvGuard(argv) {
  for (const a of argv) {
    if (VALUE_FLAG.test(a)) return 'a key value is never accepted on the command line (argv is visible in process lists); use the hidden prompt or pipe it on stdin';
    if (secretIn(a)) return 'an argument has the shape of a secret; values are never accepted on the command line';
  }
  return null;
}

// ---------------------------------------------------------------- leak scan (reuses the SECRETS patterns of launch-record-validate)
function scanText(text) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => { if (secretIn(line)) hits.push({ line: i + 1 }); });
  return hits;
}

// Local pattern set, used ONLY by channels-dedupe and channels-guard ON TOP of the shared SECRETS list (the shared list is not
// edited here; extending it is an owner decision). It covers provider shapes the shared list does not: a bare Telegram bot token,
// GitLab, Hugging Face, npm, Stripe live, SendGrid, DigitalOcean, Slack xoxe/xoxb, Groq, and a lowercase `api_key` assigned a long quoted value
// or `token: "<long value>"` assignment (a placeholder word in the value, or a ${VAR} reference, is not a hit).
const LOCAL_SECRETS = [
  /(?<![A-Za-z0-9_])\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
  /\b[sr]k_live_[A-Za-z0-9]{16,}/,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/,
  /\bdop_v1_[A-Za-z0-9]{32,}/,
  /\bxox[be]-[A-Za-z0-9-]{10,}/,
  /\bxoxe\.xox[bp]-[A-Za-z0-9-]{10,}/,
  /\bgsk_[A-Za-z0-9]{20,}/,
  /\b(?:[a-z][a-z0-9_.-]*)?(?:api_?key|token|secret|passw(?:or)?d)["']?\s*[:=]\s*["'](?![^"']*(?:your|example|placeholder|changeme|redacted|xxxx))[A-Za-z0-9_\-+/=.]{20,}["']/i,
];
function localSecretIn(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return secretIn(text) || LOCAL_SECRETS.some(re => re.test(text));
}
function scanTextLocal(text) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => { if (localSecretIn(line)) hits.push({ line: i + 1 }); });
  return hits;
}

// ---------------------------------------------------------------- stores
// Store interface (sync): list() -> stored names; has(name); get(name) -> value or null; set(name, value); remove(name) -> bool.
class FakeStore {
  constructor(file) { this.file = file || null; this.map = new Map(); this.fake = true; }
  _load() {
    if (!this.file) return;
    this.map = new Map();
    if (fs.existsSync(this.file)) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(k, v);
  }
  _save() { if (this.file) fs.writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.map)), 'utf8'); }
  list() { this._load(); return [...this.map.keys()].sort(); }
  has(name) { this._load(); return this.map.has(name); }
  get(name) { this._load(); return this.map.has(name) ? this.map.get(name) : null; }
  set(name, value) { this._load(); this.map.set(name, value); this._save(); }
  remove(name) { this._load(); const had = this.map.delete(name); this._save(); return had; }
}

function presenceView(store) {
  return Object.freeze({ list: () => store.list(), has: (n) => store.has(n), fake: !!store.fake });
}

function realExec(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, opts));
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

// Windows Credential Manager through advapi32 (CredRead, CredWrite, CredDelete, CredEnumerate) in PowerShell with Add-Type.
// The script is ASCII-only and carries no value. The operation and the target name travel in the child environment
// (names are not secret), the value travels on stdin as base64 (ASCII: no console codepage can mangle it).
const WIN_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  'Add-Type -TypeDefinition @"',
  'using System;',
  'using System.Runtime.InteropServices;',
  'using System.Text;',
  'public static class ChCred {',
  '  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
  '  public struct CREDENTIAL {',
  '    public uint Flags; public uint Type; public string TargetName; public string Comment;',
  '    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;',
  '    public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;',
  '    public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;',
  '  }',
  '  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr cred);',
  '  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredWriteW(ref CREDENTIAL cred, uint flags);',
  '  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredDeleteW(string target, uint type, uint flags);',
  '  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);',
  '  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr buf);',
  '  const int NOT_FOUND = 1168;',
  '  public static string Get(string t) {',
  '    IntPtr p;',
  '    if (!CredReadW(t, 1, 0, out p)) { if (Marshal.GetLastWin32Error() == NOT_FOUND) return null; throw new Exception("CredRead failed " + Marshal.GetLastWin32Error()); }',
  '    try {',
  '      CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));',
  '      byte[] b = new byte[c.CredentialBlobSize];',
  '      if (b.Length > 0) Marshal.Copy(c.CredentialBlob, b, 0, b.Length);',
  '      return Encoding.Unicode.GetString(b);',
  '    } finally { CredFree(p); }',
  '  }',
  '  public static void Set(string t, string v) {',
  '    byte[] b = Encoding.Unicode.GetBytes(v);',
  '    if (b.Length > 2560) throw new Exception("value too long for the store");',
  '    IntPtr blob = Marshal.AllocHGlobal(b.Length);',
  '    try {',
  '      Marshal.Copy(b, 0, blob, b.Length);',
  '      CREDENTIAL c = new CREDENTIAL();',
  '      c.Type = 1; c.TargetName = t; c.CredentialBlobSize = (uint)b.Length; c.CredentialBlob = blob; c.Persist = 2; c.UserName = "keystore";',
  '      if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed " + Marshal.GetLastWin32Error());',
  '    } finally { Marshal.Copy(new byte[b.Length], 0, blob, b.Length); Marshal.FreeHGlobal(blob); }',
  '  }',
  '  public static bool Remove(string t) {',
  '    if (CredDeleteW(t, 1, 0)) return true;',
  '    if (Marshal.GetLastWin32Error() == NOT_FOUND) return false;',
  '    throw new Exception("CredDelete failed " + Marshal.GetLastWin32Error());',
  '  }',
  '  public static string[] List(string filter) {',
  '    uint n; IntPtr arr;',
  '    if (!CredEnumerateW(filter, 0, out n, out arr)) { if (Marshal.GetLastWin32Error() == NOT_FOUND) return new string[0]; throw new Exception("CredEnumerate failed " + Marshal.GetLastWin32Error()); }',
  '    try {',
  '      string[] names = new string[n];',
  '      for (int i = 0; i < n; i++) {',
  '        IntPtr item = Marshal.ReadIntPtr(arr, i * IntPtr.Size);',
  '        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(item, typeof(CREDENTIAL));',
  '        names[i] = c.TargetName;',
  '      }',
  '      return names;',
  '    } finally { CredFree(arr); }',
  '  }',
  '}',
  '"@',
  '$op = $env:CHANNELS_OP',
  '$target = $env:CHANNELS_TARGET',
  'function ReadB64Stdin {',
  '  $ms = New-Object System.IO.MemoryStream',
  '  [Console]::OpenStandardInput().CopyTo($ms)',
  '  $s = [Text.Encoding]::ASCII.GetString($ms.ToArray()).Trim()',
  '  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s))',
  '}',
  "if ($op -eq 'get') {",
  '  $v = [ChCred]::Get($target)',
  '  if ($v -eq $null) { exit 3 }',
  '  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($v)))',
  "} elseif ($op -eq 'set') {",
  '  [ChCred]::Set($target, (ReadB64Stdin))',
  "} elseif ($op -eq 'remove') {",
  '  if (-not [ChCred]::Remove($target)) { exit 3 }',
  "} elseif ($op -eq 'list') {",
  "  foreach ($n in [ChCred]::List($env:CHANNELS_FILTER)) { [Console]::Out.WriteLine($n) }",
  '} else { throw "unknown op" }',
  '',
].join('\n');

class WindowsStore {
  constructor(exec) { this.exec = exec || realExec; }
  _run(op, target, stdin) {
    const encoded = Buffer.from(WIN_SCRIPT, 'utf16le').toString('base64');
    const env = Object.assign({}, process.env, { CHANNELS_OP: op, CHANNELS_TARGET: target || '', CHANNELS_FILTER: `${PREFIX}*` });
    const r = this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { input: stdin || '', env, timeout: 60000 });
    if (r.error) throw new Error(`credential store: cannot run powershell (${r.error.code || 'error'})`);
    if (r.code !== 0 && r.code !== 3) throw new Error(`credential store: ${op} failed (exit ${r.code})`);
    return r;
  }
  list() { return this._run('list', '').stdout.split(/\r?\n/).map(s => s.trim()).filter(s => STORED_RE.test(s) || s.startsWith(PREFIX)).sort(); }
  has(name) { return this.list().includes(name); }
  get(name) {
    const r = this._run('get', name);
    if (r.code === 3) return null;
    return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
  }
  set(name, value) { this._run('set', name, Buffer.from(value, 'utf8').toString('base64')); }
  remove(name) { return this._run('remove', name).code !== 3; }
}

// macOS Keychain: `security -i` reads its commands from stdin, so the value is never in argv.
class MacStore {
  constructor(exec) { this.exec = exec || realExec; this.account = 'keystore'; }
  list() {
    const r = this.exec('security', ['dump-keychain'], {});
    if (r.error) throw new Error('credential store: cannot run security');
    const names = new Set();
    for (const m of r.stdout.matchAll(/"svce"<blob>="(KEYSTORE_[A-Z0-9_]+)"/g)) names.add(m[1]);
    return [...names].sort();
  }
  has(name) { return this.list().includes(name); }
  get(name) {
    const r = this.exec('security', ['find-generic-password', '-a', this.account, '-s', name, '-w'], {});
    if (r.error) throw new Error('credential store: cannot run security');
    return r.code === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
  }
  set(name, value) {
    const r = this.exec('security', ['-i'], { input: `add-generic-password -a "${this.account}" -s "${name}" -w "${value}" -U\n` });
    if (r.error || r.code !== 0) throw new Error(`credential store: set failed (exit ${r.code})`);
  }
  remove(name) {
    const r = this.exec('security', ['delete-generic-password', '-a', this.account, '-s', name], {});
    return r.code === 0;
  }
}

// Linux libsecret through secret-tool: the secret is read from stdin by `store`.
class LinuxStore {
  constructor(exec) { this.exec = exec || realExec; }
  list() {
    const r = this.exec('secret-tool', ['search', '--all', 'service', 'keystore'], {});
    if (r.error) throw new Error('credential store: cannot run secret-tool (install libsecret-tools)');
    // The output also carries secrets; only the attribute.name lines are read and everything else is dropped here.
    const names = new Set();
    for (const m of r.stdout.matchAll(/^attribute\.name = (KEYSTORE_[A-Z0-9_]+)\s*$/gm)) names.add(m[1]);
    return [...names].sort();
  }
  has(name) { return this.list().includes(name); }
  get(name) {
    const r = this.exec('secret-tool', ['lookup', 'service', 'keystore', 'name', name], {});
    if (r.error) throw new Error('credential store: cannot run secret-tool');
    return r.code === 0 ? r.stdout : null;
  }
  set(name, value) {
    const r = this.exec('secret-tool', ['store', `--label=${name}`, 'service', 'keystore', 'name', name], { input: value });
    if (r.error || r.code !== 0) throw new Error(`credential store: set failed (exit ${r.code})`);
  }
  remove(name) {
    const r = this.exec('secret-tool', ['clear', 'service', 'keystore', 'name', name], {});
    return r.code === 0;
  }
}

// The fake store is a test switch. It is honoured only when NODE_ENV=test or CHANNELS_ALLOW_FAKE_STORE=1 is also set; otherwise the
// variable is ignored, the real store is used and one line (names only) is passed to warn (default: stderr).
function fakeStoreAllowed(e) { return e.NODE_ENV === 'test' || e[ALLOW_FAKE_ENV] === '1'; }
function selectStore(env, platform, exec, warn) {
  const e = env || process.env;
  if (e[FAKE_STORE_ENV]) {
    if (fakeStoreAllowed(e)) return new FakeStore(e[FAKE_STORE_ENV]);
    const line = `[ignored ${FAKE_STORE_ENV}: the fake store needs NODE_ENV=test or ${ALLOW_FAKE_ENV}=1; using the real credential store]`;
    if (warn) warn(line); else process.stderr.write(`${line}\n`);
  }
  const p = platform || process.platform;
  if (p === 'win32') return new WindowsStore(exec);
  if (p === 'darwin') return new MacStore(exec);
  if (p === 'linux') return new LinuxStore(exec);
  throw new Error(`no credential store for platform ${p}`);
}

const CMD_META = /[&|<>^%"!()\r\n]/;
// Windows: find the file for a bare command name; .cmd/.bat shims need cmd.exe, which re-parses special characters, so any
// argument with a cmd metacharacter is refused for them.
function resolveCommand(cmdline, platform, env, exists) {
  const [cmd, ...args] = cmdline;
  if (platform !== 'win32') return { file: cmd, args };
  const ex = exists || fs.existsSync;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  let found = null;
  const hasSep = /[\\/]/.test(cmd);
  const dirs = hasSep ? [''] : String(env.PATH || env.Path || '').split(';').filter(Boolean);
  outer: for (const d of dirs) {
    const base = hasSep ? cmd : path.join(d, cmd);
    const cands = path.extname(base) ? [base] : exts.map(e => base + e.toLowerCase());
    for (const c of cands) if (ex(c)) { found = c; break outer; }
  }
  if (!found) return { file: cmd, args };
  if (/\.(cmd|bat)$/i.test(found)) {
    if (CMD_META.test(found) || args.some(a => CMD_META.test(a))) return { error: `refused: ${path.basename(found)} is a cmd shim and an argument has a cmd special character; call the underlying program directly` };
    const q = (s) => (/[\s]/.test(s) ? `"${s}"` : s);
    return { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[found, ...args].map(q).join(' ')}"`], verbatim: true };
  }
  return { file: found, args };
}


// Resolve (Windows shims) and run a command to completion. Returns { code, stdout, stderr, error }.
function runCommand(cmdline, opts) {
  const r = resolveCommand(cmdline, process.platform, process.env);
  if (r.error) return { code: null, stdout: '', stderr: '', error: Object.assign(new Error(r.error), { code: 'EREFUSED' }) };
  return realExec(r.file, r.args, Object.assign({ windowsVerbatimArguments: !!r.verbatim }, opts));
}

// ---------------------------------------------------------------- stored keys, grouped
// Returns [{ name, service, alias, channel }] for every KEYSTORE_<SERVICE>_<ALIAS> in the store (names only).
function storedKeys(cat, view) {
  const out = [];
  for (const name of view.list()) {
    const p = parseStoredName(name);
    if (!p) continue;
    const ch = channelByService(cat, p.service);
    out.push({ name, service: p.service, alias: p.alias, channel: ch ? ch.id : null });
  }
  return out;
}

// ---------------------------------------------------------------- redaction of child output
// Streaming exact-match redactor: replaces every occurrence of each value with [REDACTED:NAME]; keeps a tail so a value
// split across two chunks is still caught. Exact text only: transformed copies (base64, urlencoded) are NOT covered.
function makeRedactor(pairs) {
  const items = pairs.filter(p => p.value).sort((a, b) => b.value.length - a.value.length);
  const hold = items.length ? Math.max(...items.map(i => i.value.length)) - 1 : 0;
  let tail = '';
  const apply = (s) => { let o = s; for (const it of items) o = o.split(it.value).join('[REDACTED:' + it.name + ']'); return o; };
  return {
    push(chunk) {
      const s = apply(tail + chunk);
      if (s.length <= hold) { tail = s; return ''; }
      tail = s.slice(s.length - hold);
      return s.slice(0, s.length - hold);
    },
    flush() { const o = apply(tail); tail = ''; return o; },
  };
}

function tempRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'channels-')); }

module.exports = {
  PREFIX, SERVICE_RE, ALIAS_RE, STORED_RE, KINDS, LOGIN_METHODS, KEY_CHECK_STATUSES, VERIFY_AUTH, keyPage, keyPageLines, FAKE_STORE_ENV, ALLOW_FAKE_ENV, WIN_SCRIPT,
  defaultCatalogPath, loadCatalog, validateCatalog, isOffered, findChannel, channelByService,
  storedName, parseStoredName, checkValue, argvGuard, scanText, LOCAL_SECRETS, localSecretIn, scanTextLocal,
  FakeStore, WindowsStore, MacStore, LinuxStore, selectStore, presenceView, storedKeys, realExec,
  makeRedactor, tempRoot, secretIn, resolveCommand, runCommand, toolRel,
};
