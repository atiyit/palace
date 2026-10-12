$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $projectDir '.palace-runtime\server-session.json')) {
  & (Join-Path $PSScriptRoot 'bootstrap.ps1') -Stop
  exit $LASTEXITCODE
}
$pidFile = Join-Path $projectDir '.palace-data\server.pid'
$serverFile = Join-Path $projectDir 'local\server.mjs'
if (-not (Test-Path -LiteralPath $pidFile)) { Write-Host 'No launcher-owned server is recorded.'; exit 0 }
$serverPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
$serverProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
if ($serverProcess -and $serverProcess.Name -eq 'node.exe' -and $serverProcess.CommandLine.Contains($serverFile)) {
  Stop-Process -Id $serverPid
  Write-Host 'Palace stopped. Your local data is preserved.'
} elseif ($serverProcess) {
  throw 'The recorded process does not match this local app; nothing was stopped.'
}
Remove-Item -LiteralPath $pidFile -Force
