[CmdletBinding()]
param(
    [string]$Model = $(if ($env:M365_DEFAULT_MODEL) { $env:M365_DEFAULT_MODEL } else { "gpt-5.5" }),
    [switch]$Fresh,
    [switch]$Fake
)

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot
Set-Location -LiteralPath $Root
$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$stateDir = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$envFile = Join-Path $configDir "proxy.env"
$pidFile = Join-Path $stateDir "proxy.pid"
$watchdogPidFile = Join-Path $stateDir "watchdog.pid"
$stopFile = Join-Path $stateDir "watchdog.stop"
$port = 4141
$proxyUrl = "http://127.0.0.1:$port"

function Fail([string]$Message) { throw "[proxy-up] $Message" }
function Info([string]$Message) { Write-Host "[proxy-up] $Message" -ForegroundColor Cyan }

function Invoke-Pnpm([string[]]$Arguments) {
    if (Get-Command pnpm -ErrorAction SilentlyContinue) { & pnpm @Arguments }
    elseif (Get-Command corepack -ErrorAction SilentlyContinue) { & corepack pnpm @Arguments }
    else {
        Info "pnpm is missing; installing the repository-pinned version 10.32.1"
        & npm install -g pnpm@10.32.1
        if ($LASTEXITCODE -ne 0) { Fail "pnpm installation failed" }
        & pnpm @Arguments
    }
    if ($LASTEXITCODE -ne 0) { Fail "pnpm $($Arguments -join ' ') failed with exit code $LASTEXITCODE" }
}

function Import-ProxyEnvironment {
    Get-Content -LiteralPath $envFile | ForEach-Object {
        if ($_ -match '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim().Trim('"', "'"), "Process")
        }
    }
}

function Test-ProxyHealth {
    try {
        $health = Invoke-RestMethod -Uri "$proxyUrl/health" -TimeoutSec 2
        return $health.status -eq "ok" -and $health.service -eq "m365-copilot-proxy"
    } catch { return $false }
}

# Iterative (non-recursive-call) directory walk that never descends into
# node_modules/dist/.output. Get-ChildItem -Recurse has to stat every file
# before the caller can filter it out, and pnpm's per-package node_modules is
# a symlink farm into the shared store containing tens of thousands of files
# plus paths that exceed Windows' 260-char MAX_PATH once nested under this
# repo's full path -- so a naive recursive scan is both extremely slow and
# occasionally throws. Skipping those directory names during the walk itself
# avoids both problems instead of filtering the (already expensive) results.
function Get-WorkspaceSourceFiles([string[]]$Paths) {
    $skipDirs = @('node_modules', 'dist', '.output')
    $stack = [System.Collections.Generic.Stack[string]]::new()
    foreach ($p in $Paths) {
        if (Test-Path -LiteralPath $p -PathType Leaf) { Get-Item -LiteralPath $p }
        elseif (Test-Path -LiteralPath $p -PathType Container) { $stack.Push($p) }
    }
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        foreach ($entry in (Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            if ($entry.PSIsContainer) {
                if ($skipDirs -notcontains $entry.Name) { $stack.Push($entry.FullName) }
            } else {
                $entry
            }
        }
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail "Node.js is required. Install Node.js LTS and rerun." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "npm is required but was not found beside Node.js." }
New-Item -ItemType Directory -Force -Path $configDir, $stateDir | Out-Null
$stdinFile = Join-Path $stateDir "stdin.empty"
if (-not (Test-Path -LiteralPath $stdinFile)) { New-Item -ItemType File -Path $stdinFile | Out-Null }

if (-not (Test-Path -LiteralPath $envFile)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    @(
        "M365_PROXY_API_KEY=$secret"
        "M365_REQUIRE_API_KEY=1"
        "HOST=127.0.0.1"
        "NITRO_HOST=127.0.0.1"
        "PORT=4141"
        "M365_DEFAULT_MODEL=$Model"
    ) | Set-Content -LiteralPath $envFile -Encoding ASCII
    Info "created private local configuration at $envFile"
}
Import-ProxyEnvironment
if (-not $env:M365_PROXY_API_KEY) { Fail "M365_PROXY_API_KEY is missing from $envFile" }

# Binding and authentication are safety invariants for this convenience entry point.
$env:HOST = "127.0.0.1"
$env:NITRO_HOST = "127.0.0.1"
$env:PORT = "$port"
$env:NITRO_PORT = "$port"
$env:M365_REQUIRE_API_KEY = "1"
$env:M365_DEFAULT_MODEL = $Model
if ($Fake) { $env:M365_FAKE_MODE = "1" } else { Remove-Item Env:M365_FAKE_MODE -ErrorAction SilentlyContinue }
if ($DebugPreference -ne "SilentlyContinue") { $env:M365_DEBUG = "1" }

if (Test-ProxyHealth) {
    $models = Invoke-RestMethod -Uri "$proxyUrl/v1/models" -TimeoutSec 5
    Write-Host "Proxy is already healthy at $proxyUrl" -ForegroundColor Green
    Write-Host "Models: $($models.data.Count) available"
    exit 0
}

$modulesStamp = Join-Path $Root "node_modules\.modules.yaml"
if ($Fresh -or -not (Test-Path -LiteralPath $modulesStamp) -or (Get-Item pnpm-lock.yaml).LastWriteTimeUtc -gt (Get-Item $modulesStamp -ErrorAction SilentlyContinue).LastWriteTimeUtc) {
    Info "installing locked dependencies"
    Invoke-Pnpm @("install", "--frozen-lockfile")
}

$serverEntry = Join-Path $Root "packages\proxy\.output\server\index.mjs"
$buildNeeded = $Fresh -or -not (Test-Path -LiteralPath $serverEntry)
if (-not $buildNeeded) {
    $builtAt = (Get-Item -LiteralPath $serverEntry).LastWriteTimeUtc
    $newerSource = Get-WorkspaceSourceFiles @((Join-Path $Root "packages"), (Join-Path $Root "package.json"), (Join-Path $Root "pnpm-lock.yaml")) |
        Where-Object { $_.LastWriteTimeUtc -gt $builtAt } |
        Select-Object -First 1
    $buildNeeded = $null -ne $newerSource
}
if ($buildNeeded) {
    Info "building workspace"
    Invoke-Pnpm @("build")
}

if (-not $Fake) {
    $authDir = Join-Path $env:USERPROFILE ".config\opencode-m365"
    $hasLogin = (Test-Path (Join-Path $authDir "msal-cache.json")) -or (Test-Path (Join-Path $authDir "secrets.json"))
    if (-not $hasLogin) {
        Info "Microsoft login is required; opening the repository's interactive browser flow"
        & node (Join-Path $Root "scripts\auth-interactive.mjs")
        if ($LASTEXITCODE -ne 0) { Fail "Microsoft login did not complete" }
    }
}

Remove-Item -LiteralPath $stopFile -Force -ErrorAction SilentlyContinue
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logFile = Join-Path $stateDir "proxy.$stamp.log"
$errFile = Join-Path $stateDir "proxy.$stamp.err.log"
$launcher = Join-Path $Root "packages\proxy\bin\m365-proxy.mjs"
$start = @{
    FilePath = (Get-Command node).Source
    ArgumentList = @("`"$launcher`"")
    WorkingDirectory = $Root
    PassThru = $true
    RedirectStandardOutput = $logFile
    RedirectStandardError = $errFile
}
if ($env:OS -eq "Windows_NT") { $start.WindowStyle = "Hidden" }
if ($env:OS -eq "Windows_NT") { $start.RedirectStandardInput = $stdinFile }
$proxy = Start-Process @start
Set-Content -LiteralPath $pidFile -Value $proxy.Id -Encoding ASCII
Set-Content -LiteralPath (Join-Path $stateDir "proxy-log.path") -Value $logFile -Encoding ASCII

$ready = $false
for ($i = 0; $i -lt 80; $i++) {
    if (Test-ProxyHealth) { $ready = $true; break }
    if ($proxy.HasExited) { break }
    Start-Sleep -Milliseconds 500
}
if (-not $ready) {
    $tail = if (Test-Path $errFile) { (Get-Content -LiteralPath $errFile -Tail 20) -join [Environment]::NewLine } else { "no error log" }
    Fail "proxy did not become healthy within 40 seconds.`n$tail"
}

$models = Invoke-RestMethod -Uri "$proxyUrl/v1/models" -TimeoutSec 10
$selected = $models.data | Where-Object { $_.id -eq $Model } | Select-Object -First 1
if (-not $selected) { $selected = $models.data | Where-Object { $_.id -eq "gpt-5.5" } | Select-Object -First 1 }

$shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { (Get-Command pwsh).Source } else { (Get-Command powershell).Source }
$watch = Join-Path $Root "scripts\watch-proxy.ps1"
$watchArgs = @("-NoProfile", "-File", "`"$watch`"", "-Root", "`"$Root`"", "-Port", "$port", "-StateDir", "`"$stateDir`"", "-StopFile", "`"$stopFile`"")
$watchStart = @{
    FilePath = $shell
    ArgumentList = $watchArgs
    WorkingDirectory = $Root
    PassThru = $true
    RedirectStandardOutput = (Join-Path $stateDir "watchdog.log")
    RedirectStandardError = (Join-Path $stateDir "watchdog.err.log")
}
if ($env:OS -eq "Windows_NT") { $watchStart.WindowStyle = "Hidden" }
if ($env:OS -eq "Windows_NT") { $watchStart.RedirectStandardInput = $stdinFile }
$watchdog = Start-Process @watchStart
Set-Content -LiteralPath $watchdogPidFile -Value $watchdog.Id -Encoding ASCII

$health = Invoke-RestMethod -Uri "$proxyUrl/health" -TimeoutSec 5
Write-Host "Proxy started successfully" -ForegroundColor Green
Write-Host "PID: $($proxy.Id)"
Write-Host "URL: $proxyUrl"
Write-Host "Health: $($health.status) ($($health.tool_bridge_mode) tool bridge)"
Write-Host "Model: $($selected.id)$(if ($selected.m365.tone) { " (tone $($selected.m365.tone))" })"
Write-Host "Log: $logFile"
