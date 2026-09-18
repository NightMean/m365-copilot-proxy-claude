<#
.SYNOPSIS
    Archives the repository into a clean, transfer-ready ZIP file, excluding all
    temporary files, caches, build artifacts, and secret tokens.

.DESCRIPTION
    Excludes:
      - node_modules (root and all workspace packages)
      - .scratch / temporary scratchpads
      - dist, .output, .nitro build artifacts
      - .git directory
      - .env, token.txt, msal-cache.json, secrets.json, *.db, *.log, *.har
      - VS Code / editor caches (.vscode, .idea)

.PARAMETER Destination
    The output path for the archive. Defaults to '..\m365-copilot-proxy-transfer.zip'.

.PARAMETER IncludeDist
    Optional switch to include compiled dist/ packages if moving to a machine without TypeScript/build tools.
#>
[CmdletBinding()]
param(
    [string]$Destination = "..\m365-copilot-proxy-transfer.zip",
    [switch]$IncludeDist
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
if (-not $repoRoot) {
    $repoRoot = Get-Location
}
$repoRoot = (Resolve-Path $repoRoot).Path

$destPath = [System.IO.Path]::GetFullPath((Join-Path $repoRoot $Destination))
$destDir = [System.IO.Path]::GetDirectoryName($destPath)
if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir -Force | Out-Null
}

if (Test-Path $destPath) {
    Write-Host "Removing existing archive at $destPath..." -ForegroundColor Yellow
    Remove-Item $destPath -Force
}

Write-Host "Scanning repository at: $repoRoot" -ForegroundColor Cyan

# Patterns to exclude (matched against relative paths)
$excludeRegexList = @(
    "(^|[\\/])node_modules([\\/]|$)",
    "(^|[\\/])\.scratch([\\/]|$)",
    "(^|[\\/])\.git([\\/]|$)",
    "(^|[\\/])\.nitro([\\/]|$)",
    "(^|[\\/])\.output([\\/]|$)",
    "(^|[\\/])\.vscode([\\/]|$)",
    "(^|[\\/])\.idea([\\/]|$)",
    "(^|[\\/])\.claude([\\/]|$)",
    "(^|[\\/])\.runtime([\\/]|$)",
    "(^|[\\/])\.pi-local([\\/]|$)",
    "(^|[\\/])vendor([\\/]|$)",
    "(^|[\\/])benchmarks([\\/]|$)",
    "(^|[\\/])scripts[\\/].*-out([\\/]|$)",
    "\.env(\..+)?$",
    "token\.txt$",
    "msal-cache\.json$",
    "secrets\.json$",
    "\.db(-.+)?$",
    "\.log$",
    "\.har$",
    "\.pid$",
    "\.DS_Store$",
    "Thumbs\.db$"
)

if (-not $IncludeDist) {
    $excludeRegexList += "(^|[\\/])dist([\\/]|$)"
}

$regexPattern = ($excludeRegexList -join "|")

# Gather files
$allFiles = Get-ChildItem -Path $repoRoot -Recurse -File -Force | Where-Object {
    $relPath = $_.FullName.Substring($repoRoot.Length).TrimStart("\", "/")
    $relPath -notmatch $regexPattern
}

Write-Host "Found $($allFiles.Count) files to package." -ForegroundColor Green

# Create temporary staging directory
$tempStage = Join-Path ([System.IO.Path]::GetTempPath()) ("m365-pkg-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempStage -Force | Out-Null

try {
    Write-Host "Staging clean tree..." -ForegroundColor Cyan
    foreach ($file in $allFiles) {
        $relPath = $file.FullName.Substring($repoRoot.Length).TrimStart("\", "/")
        $targetFile = Join-Path $tempStage $relPath
        $targetDir = [System.IO.Path]::GetDirectoryName($targetFile)
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -Path $file.FullName -Destination $targetFile -Force
    }

    Write-Host "Compressing archive to: $destPath" -ForegroundColor Cyan
    Compress-Archive -Path "$tempStage\*" -DestinationPath $destPath -CompressionLevel Optimal

    $archiveSizeMB = [math]::Round(((Get-Item $destPath).Length / 1MB), 2)
    Write-Host "Archive created successfully: $destPath ($archiveSizeMB MB)" -ForegroundColor Green
    Write-Host "`nTo unpack on target machine:" -ForegroundColor Gray
    Write-Host "  Expand-Archive -Path $destPath -DestinationPath m365-copilot-proxy" -ForegroundColor Gray
    Write-Host "  cd m365-copilot-proxy" -ForegroundColor Gray
    Write-Host "  pnpm install" -ForegroundColor Gray
    Write-Host "  pnpm run build" -ForegroundColor Gray
}
finally {
    if (Test-Path $tempStage) {
        Remove-Item -Path $tempStage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
