[CmdletBinding()]
param(
    [string]$Model = "claude-opus-4.6",
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
