$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
# Process table for the operator process report (.ai/bin/operator/processes.cjs): pid, parent, creation
# time (unix ms), image name, executable, command line and CPU seconds (kernel plus user time). Read only.
$rows = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 4 } | ForEach-Object {
  $p = $_
  $created = $null
  if ($p.CreationDate) { $created = [DateTimeOffset]::new($p.CreationDate).ToUnixTimeMilliseconds() }
  $cpu = $null
  if ($null -ne $p.KernelModeTime -and $null -ne $p.UserModeTime) { $cpu = [math]::Round(([double]$p.KernelModeTime + [double]$p.UserModeTime) / 10000000, 1) }
  @{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; created = $created; name = $p.Name; exe = $p.ExecutablePath; cmd = $p.CommandLine; cpu = $cpu }
})
$rows | ConvertTo-Json -Compress -Depth 3
