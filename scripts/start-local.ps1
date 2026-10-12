param([switch]$NoBrowser, [switch]$InstallOnly, [switch]$Repair)
& (Join-Path $PSScriptRoot 'bootstrap.ps1') -NoBrowser:$NoBrowser -InstallOnly:$InstallOnly -Repair:$Repair
exit $LASTEXITCODE
