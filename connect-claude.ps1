[CmdletBinding()]
param(
    [string]$Model = $(if ($env:M365_DEFAULT_MODEL) { $env:M365_DEFAULT_MODEL } else { "gpt-5.5-think-deeper" }),
    [string]$SessionId,
    [switch]$Unsafe,
    [switch]$NewSession,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ClaudeArguments
)

# Backward-compatible advanced entry point. This launches the real installed
# Claude binary and never writes global Claude credentials/settings.
$ErrorActionPreference = "Stop"
$params = @{ Model = $Model; Unsafe = $Unsafe; NewSession = $NewSession; ClaudeArguments = $ClaudeArguments }
if ($SessionId) { $params.SessionId = $SessionId }
& (Join-Path $PSScriptRoot "claude-m365.ps1") @params
exit $LASTEXITCODE
