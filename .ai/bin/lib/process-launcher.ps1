$ErrorActionPreference = 'Stop'
# Process launcher of the test driver. Creates a Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
# assigns itself to it (so the runner child inherits the membership at creation, before any
# child code runs), starts the real runner and stays alive until the runner exits or the driver
# (the parent of this launcher) dies - whichever happens first. When this launcher ends for any
# reason the job handle closes and the operating system removes every member of the job: that is
# the OS owner which covers the death of the whole supervisor.
# Exit codes: the runner's exit code; 199 when launcher setup or registration failed;
# 98 when the parent died first. ASCII only (protocol encoding rule).
$callerTemp = $env:TEMP
$callerTmp = $env:TMP
$compileRoot = if ($callerTemp) { $callerTemp } else { [IO.Path]::GetTempPath() }
$compileTemp = Join-Path $compileRoot ('protocol-add-type-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $compileTemp
try {
  $env:TEMP = $compileTemp
  $env:TMP = $compileTemp
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class JobLauncher {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr h, int c, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION i, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool b, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern int WaitForSingleObject(IntPtr h, int ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr h, int c, IntPtr data, int size, out int used);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool member);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteFile(IntPtr h, byte[] data, uint size, out uint written, IntPtr overlapped);
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit;
    public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  static IntPtr job = IntPtr.Zero;
  static IntPtr parent = IntPtr.Zero;
  public static void AppendRegistry(string file, string row) {
    // AppendAllText uses FileShare.Read, which conflicts with concurrent Node append handles.
    // FILE_APPEND_DATA (without FILE_WRITE_DATA) makes each WriteFile append at EOF in the
    // kernel; shared read/write/delete permits the other registry writers and readers.
    // Do not use a seek-to-end FileStream: another writer can append between seek and write.
    IntPtr h = CreateFile(file, 0x0004, 0x0007, IntPtr.Zero, 3, 0x80, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    try {
      byte[] data = new System.Text.UTF8Encoding(false).GetBytes(row);
      uint written;
      if (!WriteFile(h, data, (uint)data.Length, out written, IntPtr.Zero))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      if (written != data.Length) throw new Exception("registry-short-write");
    } finally { CloseHandle(h); }
  }
  public static bool MakeKillOnCloseJob() {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { return false; }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) { return false; }
    return AssignProcessToJobObject(job, GetCurrentProcess());
  }
  public static bool ParentExited(int pid) {
    if (parent == IntPtr.Zero) parent = OpenProcess(0x00100000, false, pid); // SYNCHRONIZE
    if (parent == IntPtr.Zero) return true;
    return WaitForSingleObject(parent, 0) != 258; // handle identity cannot be reused
  }
  public static long[] Members() {
    const int size = 65536;
    IntPtr data = Marshal.AllocHGlobal(size);
    try {
      int used;
      if (!QueryInformationJobObject(job, 3, data, size, out used)) throw new Exception("job-query");
      int count = Marshal.ReadInt32(data, 4);
      if (count < 0 || count > (size - 8) / IntPtr.Size) throw new Exception("job-size");
      List<long> rows = new List<long>();
      for (int i = 0; i < count; i++) {
        int pid = (int)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
        if (pid == System.Diagnostics.Process.GetCurrentProcess().Id) continue;
        IntPtr h = OpenProcess(0x1000, false, pid);
        if (h == IntPtr.Zero) {
          if (Marshal.GetLastWin32Error() == 87) continue; // exited since the job snapshot
          throw new Exception("job-identity");
        }
        try {
          bool member;
          if (!IsProcessInJob(h, job, out member)) throw new Exception("job-membership");
          if (!member) continue; // reused pid, never ours
          long c, e, k, u;
          bool timed = GetProcessTimes(h, out c, out e, out k, out u);
          rows.Add(pid); rows.Add(timed ? (c - 116444736000000000L) / 10000 : -1);
        } finally { CloseHandle(h); }
      }
      return rows.ToArray();
    } finally { Marshal.FreeHGlobal(data); }
  }
}
'@
} finally {
  # Restore before spawning: the runner must inherit the caller's temp, not the compiler's.
  $env:TEMP = $callerTemp
  $env:TMP = $callerTmp
  [IO.Directory]::Delete($compileTemp, $true)
}
if ($args.Length -gt 0 -and $args[0] -eq '-SelfTest') {
  if (-not [JobLauncher]::MakeKillOnCloseJob()) { exit 1 }
  exit 0
}
$spec = $null
try { $spec = $env:PROTOCOL_TEST_LAUNCHER_SPEC | ConvertFrom-Json } catch { exit 199 }
if (-not $spec -or -not $spec.node -or -not $spec.args -or -not $spec.parentPid) { exit 199 }
if ([JobLauncher]::ParentExited([int]$spec.parentPid)) { exit 98 }
if (-not [JobLauncher]::MakeKillOnCloseJob()) {
  [Console]::Error.WriteLine('PROCESS-LAUNCHER-FAILED job')
  exit 199
}
$quoted = @($spec.args | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } })
$proc = $null
try { $proc = Start-Process -FilePath $spec.node -ArgumentList $quoted -NoNewWindow -PassThru } catch {
  [Console]::Error.WriteLine('PROCESS-LAUNCHER-FAILED spawn')
  exit 199
}
if ($null -eq $proc) {
  [Console]::Error.WriteLine('PROCESS-LAUNCHER-FAILED spawn')
  exit 199
}
$handle = $proc.Handle
$known = @{}
function Record-Members {
  $members = [JobLauncher]::Members()
  for ($i = 0; $i -lt $members.Length; $i += 2) {
    $key = "$($members[$i]):$($members[$i + 1])"
    if (-not $known.ContainsKey($key)) {
      $created = if ($members[$i + 1] -ge 0) { $members[$i + 1] } else { $null }
      $row = @{ schema = 'process-registry/1'; runId = $spec.runId; pid = $members[$i]; created = $created; role = 'job' }
      try { [JobLauncher]::AppendRegistry($spec.registryPath, (($row | ConvertTo-Json -Compress) + "`n")) }
      catch { [Console]::Error.WriteLine('[boundary] registry=UNVERIFIED reason=job-registration') }
      $known[$key] = $true
    }
  }
}
while (-not $proc.HasExited) {
  if ([JobLauncher]::ParentExited([int]$spec.parentPid)) { exit 98 }
  try { Record-Members } catch {
    [Console]::Error.WriteLine('[boundary] PROCESS-BOUNDARY-UNVERIFIED reason=job-registration')
    exit 199
  }
  Start-Sleep -Milliseconds 200
}
$proc.WaitForExit()
$code = $proc.ExitCode
try {
  $members = [JobLauncher]::Members()
  for ($i = 0; $i -lt $members.Length; $i += 2) {
    Record-Members
    if ($members[$i + 1] -lt 0) {
      [Console]::Error.WriteLine("[boundary] identity=UNVERIFIED reason=creation-time-unavailable pid=$($members[$i])")
      continue
    }
    [Console]::Error.WriteLine("[boundary] PROCESS-BOUNDARY-LEFTOVER reason=job-member-alive pid=$($members[$i]) created=$($members[$i + 1]) role=job")
    if ($code -eq 0) { $code = 1 }
  }
} catch {
  [Console]::Error.WriteLine('[boundary] PROCESS-BOUNDARY-UNVERIFIED reason=job-members')
  if ($code -eq 0) { $code = 1 }
}
exit $code
