[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# Clear process-level proxy routing environment variables
$names = @(
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_SMALL_FAST_MODEL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
)

$clearedCount = 0
foreach ($name in $names) {
    if ([Environment]::GetEnvironmentVariable($name, "Process")) {
        [Environment]::SetEnvironmentVariable($name, $null, "Process")
        $clearedCount++
    }
}

# Remove any connection state file
$stateDir = Join-Path $env:USERPROFILE ".local\state\m365-copilot-proxy"
$connectionFile = Join-Path $stateDir "claude-connection.env"
if (Test-Path -LiteralPath $connectionFile) {
    Remove-Item -LiteralPath $connectionFile -Force -ErrorAction SilentlyContinue
    $clearedCount++
}

Write-Host "Claude is disconnected from Microsoft 365 Copilot proxy." -ForegroundColor Green
Write-Host "The standard Claude Code CLI environment is restored." -ForegroundColor Cyan
if ($clearedCount -gt 0) {
    Write-Host "Cleared $clearedCount proxy configuration variable(s)/state file(s)."
}
