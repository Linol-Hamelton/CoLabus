$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RetireCwd {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool b, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr p, byte[] b, int n, out IntPtr r);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool w);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, IntPtr[] b, int n, out int r);
  static byte[] Read(IntPtr h, long p, int n) {
    var b = new byte[n]; IntPtr r;
    if (!ReadProcessMemory(h, new IntPtr(p), b, n, out r) || r.ToInt64() != n) throw new Exception();
    return b;
  }
  static bool Exited(IntPtr h) {
    uint code;
    // STILL_ACTIVE (259) is inconclusive, even if a process used it as its exit
    // code. Retain unknown in that case; never request extra process rights.
    return GetExitCodeProcess(h, out code) && code != 259;
  }
  // state: ok = cwd read; denied = the handle was refused (another principal or a
  // protected process, so it cannot be a user shell inside a worktree); unreadable =
  // anything else, which the caller must treat as unknown. exited means the
  // opened process has a terminal exit code, or its pid no longer exists.
  public static string Get(int pid, out string state) {
    state = "unreadable";
    if (IntPtr.Size != 8) return null;
    IntPtr h = OpenProcess(0x410, false, pid);
    if (h == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      state = error == 5 ? "denied" : error == 87 ? "exited" : "unreadable";
      return null;
    }
    try {
      if (Exited(h)) { state = "exited"; return null; }
      bool wow; if (!IsWow64Process(h, out wow)) return null;
      string cwd;
      if (wow) {
        // 32-bit process: PEB32 -> ProcessParameters32 -> CurrentDirectory.DosPath.
        var peb32 = new IntPtr[1]; int len;
        if (NtQueryInformationProcess(h, 26, peb32, IntPtr.Size, out len) != 0 || peb32[0].ToInt64() == 0) return null;
        long pp = BitConverter.ToUInt32(Read(h, peb32[0].ToInt64() + 0x10, 4), 0);
        var u = Read(h, pp + 0x24, 8);
        int count = BitConverter.ToUInt16(u, 0);
        if (count == 0 || count > 65532 || count % 2 != 0) return null;
        cwd = System.Text.Encoding.Unicode.GetString(Read(h, BitConverter.ToUInt32(u, 4), count));
      } else {
        var basic = new IntPtr[6]; int len;
        if (NtQueryInformationProcess(h, 0, basic, 48, out len) != 0) return null;
        long pp = BitConverter.ToInt64(Read(h, basic[1].ToInt64() + 0x20, 8), 0);
        var u = Read(h, pp + 0x38, 16);
        int count = BitConverter.ToUInt16(u, 0);
        if (count == 0 || count > 65532 || count % 2 != 0) return null;
        cwd = System.Text.Encoding.Unicode.GetString(Read(h, BitConverter.ToInt64(u, 8), count));
      }
      if (Exited(h)) { state = "exited"; return null; }
      state = "ok"; return cwd;
    } catch {
      if (Exited(h)) state = "exited";
      return null;
    } finally { CloseHandle(h); }
  }
}
'@
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 4 } | ForEach-Object {
  $p = $_
  # Startup and exit can race the CIM snapshot and the native PEB read. Retry
  # an incomplete live row briefly, refreshing only the SAME process identity.
  # A persistent read failure or a reused pid remains unknown, never idle.
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $state = 'unreadable'
    $cwd = [RetireCwd]::Get([int]$p.ProcessId, [ref]$state)
    if ($state -eq 'exited' -or $state -eq 'denied' -or
        ($state -eq 'ok' -and $cwd -and $p.CommandLine -is [string])) { break }
    if ($attempt -eq 2) { break }
    Start-Sleep -Milliseconds 25
    $fresh = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ProcessId)"
    if (-not $fresh) { $state = 'exited'; break }
    if (-not $p.CreationDate -or $fresh.CreationDate -ne $p.CreationDate) {
      $state = 'unreadable'; $cwd = $null; break
    }
    $p = $fresh
  }
  # R1: identity is the pair (pid, creation time). The creation time of every
  # process is part of the structured table; the tool removes a row only when
  # both pid and creation time match an ancestor pair.
  $created = $null
  if ($p.CreationDate) { $created = [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }
  # A process which exited during collection is harmless. A live one is kept in the
  # list with its state; the caller decides which unreadable rows can block a tree.
  # A CIM snapshot can outlive the process. A pid-only lookup can find a stale
  # Process object or a replacement; only the native probe's exit proof omits
  # this row. An unreadable live process still blocks retirement.
  if ($state -ne 'exited' -and ($cwd -or (Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue))) {
    @{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; created = $created; cmd = $p.CommandLine; cwd = $cwd; exe = $p.ExecutablePath; state = $state }
  }
})
# A5: the table's own root marker. The enumeration covers every process of the
# platform, so the table declares any pid not present in it absent; the ancestor
# chain may end there and only there (besides a declared platform root pid).
$rows += @{ rootMarker = 'complete' }
$rows | ConvertTo-Json -Compress -Depth 3
