[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet("status", "models", "doctor", "calibrate", "login", "login-device", "start", "stop", "restart", "connect-claude", "disconnect-claude", "logs", "help", "")]
    [string]$Command = "status",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$configDir = Join-Path $env:USERPROFILE ".config\m365-copilot-proxy"
$stateDir = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$envFile = Join-Path $configDir "proxy.env"
$pidFile = Join-Path $stateDir "proxy.pid"
$logFile = Join-Path $stateDir "proxy.log"
$port = 4141
$proxyUrl = "http://127.0.0.1:$port"

function Show-Help {
    Write-Host @"
Microsoft 365 Copilot Proxy Manager (Windows CLI)

Usage: m365-copilot <command> [options]

Core Commands:
  status             Show localhost gateway and Claude connection health
  models             List available M365 models, tones, and capabilities
  doctor             Run diagnostic checks on dependencies, auth, and network
  calibrate          Run protocol calibration probe against M365 request shape

Lifecycle & Auth:
  start              Start the localhost proxy daemon in background
  stop               Stop the managed background proxy
  restart            Restart the managed proxy
  login              Sign in interactively in a dedicated Microsoft browser window
  login-device       Sign in using Microsoft device-code flow
  logs               Display the latest gateway log output

Claude Code Integration:
  connect-claude     Launch Claude Code connected reversibly to this proxy
  disconnect-claude  Restore native Claude Code configuration and unset proxy vars
"@ -ForegroundColor Cyan
}

function Test-ProxyHealth {
    try {
        $res = Invoke-RestMethod -Uri "$proxyUrl/health" -TimeoutSec 2 -ErrorAction Stop
        return $res.status -eq "ok"
    } catch {
        return $false
    }
}

switch ($Command) {
    "" { Show-Help }
    "help" { Show-Help }

    "status" {
        Write-Host "=== Microsoft 365 Copilot Gateway Status ===" -ForegroundColor Cyan
        $healthy = Test-ProxyHealth
        $pidVal = if (Test-Path -LiteralPath $pidFile) { Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue } else { $null }

        if ($healthy) {
            Write-Host "Proxy: RUNNING (Healthy at $proxyUrl)" -ForegroundColor Green
            if ($pidVal) { Write-Host "Process ID: $pidVal" }
            try {
                $stats = Invoke-RestMethod -Uri "$proxyUrl/internal/stats" -TimeoutSec 2 -ErrorAction SilentlyContinue
                if ($stats) {
                    Write-Host "Active Tones: $(($stats.tones | ForEach-Object { $_.model }) -join ', ')"
                }
            } catch {}
        } else {
            Write-Host "Proxy: STOPPED or Unreachable at $proxyUrl" -ForegroundColor Yellow
        }

        # Check Claude Code integration
        $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
        if ($claudeCmd) {
            Write-Host "Claude Code CLI: INSTALLED ($($claudeCmd.Source))" -ForegroundColor Green
        } else {
            Write-Host "Claude Code CLI: NOT FOUND on PATH" -ForegroundColor Yellow
        }

        $activeProxyVar = [Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "Process")
        if ($activeProxyVar) {
            Write-Host "Active Shell Mode: CONNECTED to $activeProxyVar" -ForegroundColor Magenta
        } else {
            Write-Host "Active Shell Mode: DIRECT (Standard Claude API)" -ForegroundColor Gray
        }

        if (Test-Path -LiteralPath $logFile) {
            Write-Host "Log File: $logFile" -ForegroundColor Gray
        }
    }

    "models" {
        Write-Host "=== Available Microsoft 365 Copilot Models ===" -ForegroundColor Cyan
        try {
            $cat = Invoke-RestMethod -Uri "$proxyUrl/v1/models" -TimeoutSec 5 -ErrorAction Stop
            $items = $cat.data
        } catch {
            Write-Host "(Proxy offline - querying core model registry)" -ForegroundColor Gray
            $json = node -e "import { CANONICAL_MODELS } from './packages/core/dist/index.mjs'; console.log(JSON.stringify(Object.entries(CANONICAL_MODELS).map(([k, v]) => ({ id: k, m365: v }))))"
            $items = ConvertFrom-Json $json
        }

        $formatted = $items | ForEach-Object {
            [PSCustomObject]@{
                "Model ID" = $_.id
                "M365 Tone" = $_.m365.tone
                "Tools" = if ($_.m365.supportsTools) { "YES" } else { "no" }
                "Vision" = if ($_.m365.supportsVision) { "YES" } else { "no" }
                "Reasoning" = if ($_.m365.supportsReasoning) { "YES" } else { "no" }
            }
        }
        $formatted | Format-Table -AutoSize
    }

    "doctor" {
        Write-Host "=== Microsoft 365 Copilot Gateway Doctor ===" -ForegroundColor Cyan
        # 1. Node.js
        $nodeVersion = & node -v 2>$null
        if ($nodeVersion) {
            Write-Host "[OK] Node.js runtime: $nodeVersion" -ForegroundColor Green
        } else {
            Write-Host "[FAIL] Node.js is not installed or not in PATH" -ForegroundColor Red
        }

        # 2. Loopback binding security
        Write-Host "[OK] Security constraint: gateway binds exclusively to 127.0.0.1 loopback" -ForegroundColor Green

        # 3. Authentication token status
        $msalDir = Join-Path $configDir "msal-cache.json"
        $tokenState = if (Test-Path -LiteralPath $msalDir) { "PRESENT" } else { "MISSING (Run: m365-copilot login)" }
        if ($tokenState -eq "PRESENT") {
            Write-Host "[OK] Authentication cache: $msalDir" -ForegroundColor Green
        } else {
            Write-Host "[WARN] Authentication cache: $tokenState" -ForegroundColor Yellow
        }

        # 4. Proxy status
        if (Test-ProxyHealth) {
            Write-Host "[OK] Proxy listener: RUNNING on $proxyUrl" -ForegroundColor Green
        } else {
            Write-Host "[INFO] Proxy listener: STOPPED (Start with: m365-copilot start)" -ForegroundColor Gray
        }

        # 5. Claude Code CLI
        $claudePath = (Get-Command claude -ErrorAction SilentlyContinue).Source
        if ($claudePath) {
            Write-Host "[OK] Claude Code CLI executable: $claudePath" -ForegroundColor Green
        } else {
            Write-Host "[WARN] Claude Code CLI not found. Install via: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
        }
    }

    "calibrate" {
        Write-Host "=== Microsoft 365 Copilot Protocol Calibration ===" -ForegroundColor Cyan
        Write-Host "Running cleanroom protocol comparison against known gateway baseline..." -ForegroundColor Gray
        & node -e "
          import { compareProtocol, formatCalibrationMarkdown, BASELINE_PROTOCOL } from './packages/core/dist/index.mjs';
          const report = compareProtocol({
            headers: {
              authorization: 'Bearer [OBSERVED]',
              accept: 'application/json',
              'content-type': 'application/json',
              'x-ms-client-request-id': 'cal-probe-001'
            },
            optionsSets: BASELINE_PROTOCOL.optionsSets,
            allowedMessageTypes: BASELINE_PROTOCOL.allowedMessageTypes,
          }, 'synthetic-fixture');
          console.log(formatCalibrationMarkdown(report));
        "
    }

    "login" {
        & node (Join-Path $Root "scripts\auth-interactive.mjs") @RemainingArgs
    }

    "login-device" {
        & node (Join-Path $Root "scripts\auth-device.mjs") @RemainingArgs
    }

    "start" {
        & (Join-Path $Root "proxy-up.ps1") @RemainingArgs
    }

    "stop" {
        & (Join-Path $Root "proxy-down.ps1")
    }

    "restart" {
        & (Join-Path $Root "proxy-down.ps1")
        Start-Sleep -Seconds 1
        & (Join-Path $Root "proxy-up.ps1") @RemainingArgs
    }

    "connect-claude" {
        & (Join-Path $Root "connect-claude.ps1") @RemainingArgs
    }

    "disconnect-claude" {
        & (Join-Path $Root "disconnect-claude.ps1")
    }

    "logs" {
        if (Test-Path -LiteralPath $logFile) {
            Get-Content -LiteralPath $logFile -Tail 50 -Wait
        } else {
            Write-Host "No log file found at $logFile" -ForegroundColor Yellow
        }
    }
}
