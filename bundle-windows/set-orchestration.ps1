<#
Adds or removes the model split for sub-agents in the user's global CLAUDE.md, so every new
Claude Code session follows it. The block is delimited by markers, so re-running replaces it
and -Remove deletes exactly that block and nothing else.
Usage: powershell -ExecutionPolicy Bypass -File bundle-windows\set-orchestration.ps1 [-Remove]
#>
param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$Begin = '<!-- token-stack:orchestration begin -->'
$End   = '<!-- token-stack:orchestration end -->'
$Path  = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'
$Block = @(
    $Begin,
    '## Model split for sub-agents',
    '- Orchestrator (the main session): Opus 5.5 at xhigh effort. It plans, decides and verifies.',
    '- Executors (sub-agents for scoped tasks): Haiku 5.5 at low effort. When spawning an agent, use model "haiku" and effort "low".',
    '- Raise an executor''s effort only when the user asks for it.',
    $End
) -join "`r`n"

$text = if (Test-Path $Path) { [IO.File]::ReadAllText($Path) } else { '' }
$pattern = '(?s)\r?\n?' + [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End) + '\r?\n?'
$stripped = [regex]::Replace($text, $pattern, '')

if ($Remove) {
    $new = $stripped
    Write-Host 'Removed: model split block from CLAUDE.md'
} else {
    $sep = if ($stripped.Length -gt 0 -and -not $stripped.EndsWith("`n")) { "`r`n`r`n" } elseif ($stripped.Length -gt 0) { "`r`n" } else { '' }
    $new = $stripped + $sep + $Block + "`r`n"
    Write-Host 'Wrote: model split block to CLAUDE.md'
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
[IO.File]::WriteAllText($Path, $new, (New-Object System.Text.UTF8Encoding($false)))
