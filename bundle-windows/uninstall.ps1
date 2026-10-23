<#
Removes the Token Optimization Stack installed by bundle-windows\install.ps1.
Usage: powershell -ExecutionPolicy Bypass -File bundle-windows\uninstall.ps1 [-Force] [-KeepData]
Without -Force it only lists what would be removed.
RTK: runs rtk's own 'rtk init -g --uninstall' only when the manifest says this bundle enabled the hook,
then deletes bin\rtk.exe (kept if that hook removal failed, so the hook never points at a missing file).
Refuses to run while the stack is up (ports 8787, 47821, 47830, 47831).
#>
param(
    [switch]$KeepData,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$State        = Join-Path $env:USERPROFILE '.token-stack'
$Bin          = Join-Path $State 'bin'
$RtkExe       = Join-Path $env:USERPROFILE '.token-stack\bin\rtk.exe'
$HeadroomDir  = Join-Path $State 'headroom'
$GraphifyDir  = Join-Path $State 'graphify'
$GraphifyExe  = Join-Path $GraphifyDir 'Scripts\graphify.exe'
$ManifestPath = Join-Path $State 'install-manifest.json'
$ClaudeMd     = Join-Path $env:USERPROFILE '.claude\CLAUDE.md'

function Test-OnPath([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

# Runs a native command block; returns $true on exit code 0, otherwise warns and returns $false.
function Invoke-Optional([string]$Label, [scriptblock]$Block) {
    & $Block | Out-Host
    if ($LASTEXITCODE -eq 0) { Write-Host "Removed: $Label"; return $true }
    Write-Warning "Could not remove $Label (exit code $LASTEXITCODE)"
    return $false
}

$Manifest = $null
if (Test-Path $ManifestPath) {
    $Manifest = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json
} else {
    Write-Warning 'No install manifest found. npm, Ponytail and the CLAUDE.md block will not be touched.'
}

$BinFiles           = @('context-gate.mjs', 'claude-stack.mjs', 'claude-stack.cmd')
$PxpipeOwned        = $false
$PonytailOwned      = $false
$Orchestration      = $false
$GraphifyRegistered = $true
$GraphifyProject    = $null
if ($Manifest) {
    if ($Manifest.binFiles) { $BinFiles = @($Manifest.binFiles) }
    if ($Manifest.pxpipe -and $Manifest.pxpipe.owned) { $PxpipeOwned = $true }
    if ($Manifest.ponytail) { $PonytailOwned = $true }
    if ($Manifest.orchestration) { $Orchestration = $true }
    if ($Manifest.graphify) {
        $GraphifyRegistered = [bool]$Manifest.graphify.registered
        $GraphifyProject    = $Manifest.graphify.project
    }
}

# Plan
$Plan = New-Object System.Collections.Generic.List[string]
foreach ($f in $BinFiles) { $Plan.Add((Join-Path $Bin $f)) }
$RtkHookOwned = [bool]($Manifest -and $Manifest.rtkHook)
$PathOwned    = [bool]($Manifest -and $Manifest.pathAdded)
if ($RtkHookOwned) { $Plan.Add("RTK hook, via rtk's own uninstall: 'rtk init -g --uninstall' (settings.json hook, RTK.md, its CLAUDE.md line)") }
if ($PathOwned) { $Plan.Add("user PATH entry for $Bin (only because the install added it)") }
$AutoOwned = [bool]($Manifest -and $Manifest.autoRouting)
if ($AutoOwned) { $Plan.Add("automatic routing: the settings.json env block, ANTHROPIC_BASE_URL (user), the startup app TokenStackServe, and the running stack") }
$Plan.Add("RTK executable: $RtkExe")
$Plan.Add("Headroom venv: $HeadroomDir")
if ($GraphifyRegistered) {
    if ($GraphifyProject) {
        $Plan.Add("graphify registration in project $GraphifyProject, via 'graphify uninstall --project --platform claude'")
    } else {
        $Plan.Add("graphify registration, via graphify's own uninstall: /graphify skill and its '# graphify' lines in $ClaudeMd")
    }
}
$Plan.Add("graphify venv: $GraphifyDir (only after graphify's own uninstall succeeds)")
if ($PxpipeOwned) { $Plan.Add('npm global package: pxpipe-proxy') }
if ($PonytailOwned) { $Plan.Add('Claude plugin: ponytail@ponytail (claude plugin uninstall)') }
if ($Orchestration) { $Plan.Add("CLAUDE.md block between the token-stack:orchestration markers in $ClaudeMd (nothing else in that file)") }
if ($KeepData) { $Plan.Add("Kept: data files in $State (for example gate-events.jsonl)") } else { $Plan.Add("Whole state folder: $State") }

Write-Host 'Will remove:'
foreach ($item in $Plan) { Write-Host "  - $item" }
if (-not $PonytailOwned) { Write-Host 'Not removed: Ponytail plugin (not installed by this bundle).' }
Write-Host 'Not removed: your own Python, Node.js, npm and claude CLI.'
if (-not $Force) {
    Write-Host 'Nothing removed. Run again with -Force to proceed.'
    exit 0
}

# Automatic routing goes first: otherwise the running stack would block the check below.
if ($AutoOwned) {
    try { & (Join-Path $PSScriptRoot 'auto.ps1') -Disable | Out-Host } catch { Write-Warning "Automatic routing not fully removed: $($_.Exception.Message)" }
}

# Refuse to run while the stack is up: deleting files under a running proxy leaves a half-removed install.
# Only the stack's own processes count (by command line): another program on the same port does not block.
$busy = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { @(8787, 47821, 47830, 47831) -contains $_.LocalPort } |
    Where-Object { (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine -match 'context-gate\.mjs|claude-stack\.mjs|headroom|pxpipe' } |
    Select-Object -ExpandProperty LocalPort -Unique)
if ($busy.Count -gt 0) {
    Write-Host "The stack is running (ports $($busy -join ', ')). Close Claude Code sessions started with claude-stack, then run again. Nothing was removed."
    exit 1
}

# RTK hook first, while rtk.exe still exists. rtk's own uninstall removes its settings.json hook,
# RTK.md and CLAUDE.md line; nothing else is touched.
$rtkKeep = $false
if ($RtkHookOwned -and (Test-Path -LiteralPath $RtkExe)) {
    $rtkRemoved = $false
    try {
        Push-Location -Path $State
        try {
            & $RtkExe init -g --uninstall | Out-Host
            $rtkRemoved = ($LASTEXITCODE -eq 0)
        } finally { Pop-Location }
    } catch { Write-Warning "RTK hook not removed: $($_.Exception.Message)" }
    if ($rtkRemoved) {
        Write-Host 'Removed: RTK hook (rtk init -g --uninstall)'
    } else {
        $rtkKeep = $true
        Write-Warning 'RTK hook removal did not succeed: keeping rtk.exe so the hook still has its command. Check settings.json and CLAUDE.md, then run again.'
    }
}

# PATH entry, only if this bundle added it
if ($PathOwned) {
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    $kept = @(($userPath -split ';') | Where-Object { $_ -and ($_ -ne $Bin) })
    [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
    Write-Host "Removed: $Bin from the user PATH"
}

# Ponytail
if ($PonytailOwned) {
    if (Test-OnPath 'claude') {
        Invoke-Optional 'Ponytail plugin' { claude plugin uninstall ponytail@ponytail } | Out-Null
    } else {
        Write-Warning 'claude not on PATH; Ponytail plugin not removed.'
    }
}

# pxpipe
if ($PxpipeOwned) {
    if (Test-OnPath 'npm') {
        Invoke-Optional 'npm package pxpipe-proxy' { npm uninstall -g pxpipe-proxy } | Out-Null
    } else {
        Write-Warning 'npm not on PATH; pxpipe-proxy not removed.'
    }
}

# Model split block in CLAUDE.md (only if this bundle wrote it). Removed before graphify:
# graphify strips its '# graphify' section up to the next H1 heading, which would also
# take this block when it follows that section.
if ($Orchestration) {
    & (Join-Path $PSScriptRoot 'set-orchestration.ps1') -Remove
}

# graphify: its own uninstall first, keep the venv if that fails
$GraphifyKept = $false
if (Test-Path $GraphifyDir) {
    if ($GraphifyRegistered -and (Test-Path $GraphifyExe)) {
        $GraphifyOk = $false
        if ($GraphifyProject) {
            if (Test-Path -LiteralPath $GraphifyProject) {
                Push-Location -LiteralPath $GraphifyProject
                try {
                    $GraphifyOk = Invoke-Optional 'graphify project registration' { & $GraphifyExe uninstall --project --platform claude }
                } finally { Pop-Location }
            } else {
                Write-Warning "graphify project folder not found: $GraphifyProject"
            }
        } else {
            # Run from the user profile so graphify cleans user-level files only, never the current folder.
            # 'uninstall' removes the user /graphify skill; 'uninstall --project --platform claude' from the
            # profile removes graphify's '# graphify' registration in %USERPROFILE%\.claude\CLAUDE.md.
            Push-Location -LiteralPath $env:USERPROFILE
            try {
                $GraphifyOk = Invoke-Optional 'graphify skill' { & $GraphifyExe uninstall }
                if ($GraphifyOk) {
                    $GraphifyOk = Invoke-Optional 'graphify lines in CLAUDE.md' { & $GraphifyExe uninstall --project --platform claude }
                }
            } finally { Pop-Location }
        }
        $GraphifyKept = -not $GraphifyOk
    } elseif ($GraphifyRegistered) {
        Write-Warning 'graphify uninstall command not found; skipping, graphify venv kept.'
        $GraphifyKept = $true
    }
    if (-not $GraphifyKept) {
        Remove-Item -Recurse -Force -Path $GraphifyDir
        Write-Host 'Removed: graphify venv'
    }
}
if ($GraphifyKept) { Write-Warning "graphify venv kept at $GraphifyDir" }

# Headroom
if (Test-Path $HeadroomDir) {
    Remove-Item -Recurse -Force -Path $HeadroomDir
    Write-Host 'Removed: Headroom venv'
}

# Bin files
foreach ($f in $BinFiles) {
    $p = Join-Path $Bin $f
    if (Test-Path $p) { Remove-Item -Force -Path $p }
}
# rtk.exe: this one file, by its literal path, unless the hook removal failed above.
if ((Test-Path -LiteralPath $RtkExe) -and -not $rtkKeep) {
    Remove-Item -LiteralPath $RtkExe -Force
    Write-Host 'Removed: rtk.exe'
}
if ((Test-Path $Bin) -and -not (Get-ChildItem -Force -Path $Bin)) { Remove-Item -Force -Path $Bin }
Write-Host 'Removed: bin files'

# Manifest and remaining state
if ((-not $GraphifyKept) -and (Test-Path $ManifestPath)) { Remove-Item -Force -Path $ManifestPath }
if ((-not $KeepData) -and (-not $GraphifyKept) -and (Test-Path $State)) {
    Remove-Item -Recurse -Force -Path $State
    Write-Host 'Removed: state folder'
}

Write-Host 'Not removed: your own Python, Node.js, npm and claude CLI, and %USERPROFILE%\.claude settings.'
if ($GraphifyProject) { Write-Host "Not removed: graphify output files in project folder $GraphifyProject (remove them manually)." }
Write-Host 'Done.'
