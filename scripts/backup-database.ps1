param(
  [Parameter(Mandatory = $true)]
  [string]$DatabaseUrl,
  [string]$OutputDirectory = ".\backups"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command pg_dump -ErrorAction SilentlyContinue)) {
  throw "pg_dump is not installed or is not available in PATH."
}

$resolvedDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $resolvedDirectory | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputFile = Join-Path $resolvedDirectory "x-store-$timestamp.dump"

& pg_dump --format=custom --no-owner --no-acl --file=$outputFile $DatabaseUrl
if ($LASTEXITCODE -ne 0) {
  throw "Database backup failed with exit code $LASTEXITCODE."
}

$backup = Get-Item $outputFile
if ($backup.Length -le 0) {
  throw "Database backup was created but is empty."
}

Write-Host "Backup completed: $($backup.FullName)"
