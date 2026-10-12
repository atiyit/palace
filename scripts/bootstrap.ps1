param(
  [switch]$InstallOnly,
  [switch]$Repair,
  [switch]$NoBrowser,
  [switch]$Stop,
  [switch]$PrivateRuntime
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectDir = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectDir '.palace-runtime'
$nodeRoot = Join-Path $runtimeDir 'node'
New-Item -ItemType Directory -Path $nodeRoot -Force | Out-Null

function Get-UsableNode([string]$Candidate) {
  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $null }
  try {
    $result = & $Candidate (Join-Path $PSScriptRoot 'runtime-info.mjs') 2>$null
    if ($LASTEXITCODE -eq 0 -and $result) { return ($result | ConvertFrom-Json) }
  } catch {}
  return $null
}

$runtime = $null
if (-not $PrivateRuntime) {
  $systemNode = Get-Command node -ErrorAction SilentlyContinue
  if ($systemNode) { $runtime = Get-UsableNode $systemNode.Source }
}
if (-not $runtime) {
  foreach ($folder in (Get-ChildItem -LiteralPath $nodeRoot -Directory | Sort-Object Name -Descending)) {
    $runtime = Get-UsableNode (Join-Path $folder.FullName 'node.exe')
    if ($runtime) { break }
  }
}
if (-not $runtime -and $Stop) { throw 'No usable Node runtime is available. Install first, or stop the original terminal session.' }
if (-not $runtime) {
  $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $architecture = switch ($architecture.ToUpperInvariant()) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw 'Automatic runtime installation supports Windows x64 and ARM64 only.' } }
  $downloadDir = Join-Path $runtimeDir ('download-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $downloadDir | Out-Null
  Write-Host 'Preparing the current Node.js 24 LTS runtime from nodejs.org...'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' -TimeoutSec 60).Content
  $expression = '(?m)^([a-fA-F0-9]{64})\s+(node-(v24\.\d+\.\d+)-win-' + $architecture + '\.zip)\s*$'
  $match = [regex]::Match([string]$sums, $expression)
  if (-not $match.Success) { throw 'The official checksum list has no matching Windows runtime.' }
  $expectedHash = $match.Groups[1].Value
  $archiveName = $match.Groups[2].Value
  $version = $match.Groups[3].Value
  $archive = Join-Path $downloadDir $archiveName
  Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/' + $version + '/' + $archiveName) -OutFile $archive -TimeoutSec 600
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expectedHash) { throw 'Node.js archive checksum mismatch. No downloaded program was executed. Please retry.' }
  Expand-Archive -LiteralPath $archive -DestinationPath $downloadDir
  $extracted = Join-Path $downloadDir ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  $destination = Join-Path $nodeRoot ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  $runtime = Get-UsableNode (Join-Path $extracted 'node.exe')
  if (-not $runtime) { throw 'The verified Node.js runtime cannot run on this Windows version.' }
  if (Test-Path -LiteralPath $destination) { throw "The runtime folder already exists but is unusable. Rename that folder, then retry: $destination" }
  $resolvedSource = (Resolve-Path -LiteralPath $extracted).Path
  $resolvedBoundary = (Resolve-Path -LiteralPath $runtimeDir).Path + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedSource.StartsWith($resolvedBoundary, [StringComparison]::OrdinalIgnoreCase) -or -not ([IO.Path]::GetFullPath($destination)).StartsWith($resolvedBoundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime move is outside the project runtime directory.' }
  Move-Item -LiteralPath $resolvedSource -Destination $destination
  $runtime = Get-UsableNode (Join-Path $destination 'node.exe')
  Remove-Item -LiteralPath $archive
  Remove-Item -LiteralPath $downloadDir
}
$arguments = @((Join-Path $PSScriptRoot 'setup-local.mjs'), '--npm', $runtime.npm)
if ($InstallOnly) { $arguments += '--install-only' }
if ($Repair) { $arguments += '--repair' }
if ($NoBrowser) { $arguments += '--no-browser' }
if ($Stop) { $arguments += '--stop' }
& $runtime.node @arguments
exit $LASTEXITCODE
