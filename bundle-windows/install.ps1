<#
Installs the Token Optimization Stack for Claude Code on Windows (current user only).
Usage: powershell -ExecutionPolicy Bypass -File bundle-windows\install.ps1 [-NoPonytail] [-NoRtkHook] [-GraphifyProject <folder>]
RTK: the rtk.exe executable is installed (checksum verified), then rtk's own global setup runs
('rtk init -g --auto-patch') so its hook is active in every Claude Code session. -NoRtkHook skips that
step: the executable stays but nothing is written to settings.json or CLAUDE.md.
The user PATH gets the bin folder (needed for the hook's bare 'rtk' call); the uninstaller removes it.
#>
param(
    [switch]$NoPonytail,
    [switch]$NoRtkHook,
    [switch]$NoAuto,
    [string]$GraphifyProject
)

$ErrorActionPreference = 'Stop'

$HeadroomSpec = 'headroom-ai[proxy]==0.41.0'
$PxpipeSpec   = 'pxpipe-proxy@0.15.0'
$RtkVersion   = '1.0.1'
$PonytailVersion = '5.3.2'
$RtkAsset     = 'rtk-x86_64-pc-windows-msvc.zip'
$RtkBaseUrl   = "https://github.com/rtk-ai/rtk/releases/download/v$RtkVersion"

$Repo         = Split-Path -Parent $PSScriptRoot
$Scripts      = Join-Path $Repo 'scripts'
$State        = Join-Path $env:USERPROFILE '.token-stack'
$Bin          = Join-Path $State 'bin'
$RtkExe       = Join-Path $Bin 'rtk.exe'
$HeadroomDir  = Join-Path $State 'headroom'
$GraphifyDir  = Join-Path $State 'graphify'
$ManifestPath = Join-Path $State 'install-manifest.json'

function Write-Step([string]$Letter, [string]$Text) { Write-Host "[$Letter] $Text" }

function Test-OnPath([string]$Name) { return [bool](Get-Command $Name -ErrorAction SilentlyContinue) }

function Invoke-Checked([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "'$Exe $($Arguments -join ' ')' exited with code $LASTEXITCODE" }
}

# a. Prerequisites
$missing = @()
foreach ($name in @('node', 'npm', 'claude')) {
    if (-not (Test-OnPath $name)) { $missing += $name }
}
$PyExe  = $null
$PyArgs = @()
if (Test-OnPath 'py') { $PyExe = 'py'; $PyArgs = @('-3') } elseif (Test-OnPath 'python') { $PyExe = 'python' } else { $missing += 'python' }
if ($missing.Count -gt 0) {
    Write-Host ("[a] Missing on PATH: " + ($missing -join ', ') + ". Install them, open a new terminal, and run again.")
    exit 1
}
Write-Step 'a' 'Prerequisites found: node, npm, python, claude'

# b. State folders
New-Item -ItemType Directory -Force -Path $Bin | Out-Null
Write-Step 'b' "State folder ready: $State"

# c. Copy scripts
$BinFiles = @('context-gate.mjs', 'claude-stack.mjs', 'claude-stack.cmd')
foreach ($file in @('context-gate.mjs', 'claude-stack.mjs')) {
    $src = Join-Path $Scripts $file
    if (-not (Test-Path $src)) { Write-Host "[c] Missing source file: $src"; exit 1 }
    Copy-Item -Path $src -Destination $Bin -Force
}
Write-Step 'c' 'Copied context-gate.mjs and claude-stack.mjs to bin'

# d. RTK executable only. Runs before any package install, so a failed download or
#    checksum stops the install before anything else changes.
#    Never 'rtk init'; no hook, no RTK.md, no settings.json or CLAUDE.md change.
$RtkTmp    = Join-Path $env:TEMP ('token-stack-rtk-' + [guid]::NewGuid().ToString('N'))
$RtkZip    = Join-Path $RtkTmp $RtkAsset
$RtkSums   = Join-Path $RtkTmp 'checksums.txt'
$RtkTmpExe = Join-Path $RtkTmp 'rtk.exe'
New-Item -ItemType Directory -Force -Path $RtkTmp | Out-Null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -UseBasicParsing -Uri "$RtkBaseUrl/$RtkAsset" -OutFile $RtkZip
        Invoke-WebRequest -UseBasicParsing -Uri "$RtkBaseUrl/checksums.txt" -OutFile $RtkSums
    } catch {
        Write-Host "[d] ABORT: RTK download failed: $($_.Exception.Message). RTK and the remaining components were not installed."
        exit 1
    }
    $expected = $null
    foreach ($line in (Get-Content -Path $RtkSums)) {
        if (($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') -and ($Matches[2] -eq $RtkAsset)) {
            $expected = $Matches[1].ToLowerInvariant()
            break
        }
    }
    if (-not $expected) {
        Write-Host "[d] ABORT: checksums.txt has no line for $RtkAsset. RTK and the remaining components were not installed."
        exit 1
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $RtkZip).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Write-Host "[d] ABORT: SHA-256 mismatch for $RtkAsset (expected $expected, got $actual). RTK and the remaining components were not installed."
        exit 1
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($RtkZip)
    try {
        $entries = @($zip.Entries | Where-Object { $_.Name -eq 'rtk.exe' })
        if ($entries.Count -ne 1) {
            Write-Host "[d] ABORT: expected one rtk.exe in $RtkAsset, found $($entries.Count). RTK and the remaining components were not installed."
            exit 1
        }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $RtkTmpExe, $true)
    } finally {
        $zip.Dispose()
    }
    Copy-Item -Path $RtkTmpExe -Destination $RtkExe -Force
} finally {
    foreach ($p in @($RtkZip, $RtkSums, $RtkTmpExe)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
    }
    if ((Test-Path -LiteralPath $RtkTmp) -and -not (Get-ChildItem -Force -LiteralPath $RtkTmp)) { Remove-Item -LiteralPath $RtkTmp -Force }
}
Write-Step 'd' "RTK $RtkVersion executable (SHA-256 verified) copied to $RtkExe (the hook is set up in step j)"

# e. Headroom
$HeadroomPy = Join-Path $HeadroomDir 'Scripts\python.exe'
if (-not (Test-Path $HeadroomPy)) { Invoke-Checked $PyExe ($PyArgs + @('-m', 'venv', $HeadroomDir)) }
Invoke-Checked $HeadroomPy @('-m', 'pip', 'install', $HeadroomSpec)
Write-Step 'e' 'Headroom 0.41.0 installed in its venv'

# f. pxpipe (record whether this bundle installed it)
$PxpipeOwned = $false
& npm list -g pxpipe-proxy --depth=0 | Out-Null
if ($LASTEXITCODE -ne 0) { $PxpipeOwned = $true }
Invoke-Checked 'npm' @('install', '-g', $PxpipeSpec)
Write-Step 'f' 'pxpipe-proxy 0.15.0 installed globally with npm'

# g. graphify (non-fatal; graphify writes its own registration in CLAUDE.md)
$GraphifyPy  = Join-Path $GraphifyDir 'Scripts\python.exe'
$GraphifyExe = Join-Path $GraphifyDir 'Scripts\graphify.exe'
$GraphifyRegistered = $false
$GraphifyProjectUsed = $null
try {
    if (-not (Test-Path $GraphifyPy)) { Invoke-Checked $PyExe ($PyArgs + @('-m', 'venv', $GraphifyDir)) }
    Invoke-Checked $GraphifyPy @('-m', 'pip', 'install', 'graphifyy==0.9.93')
    if ($GraphifyProject) {
        $GraphifyProjectUsed = (Resolve-Path -Path $GraphifyProject).Path
        Push-Location -Path $GraphifyProjectUsed
        try { Invoke-Checked $GraphifyExe @('install', '--project') } finally { Pop-Location }
    } else {
        Invoke-Checked $GraphifyExe @('install')
    }
    $GraphifyRegistered = $true
    Write-Step 'g' 'graphify installed and /graphify skill registered'
} catch {
    Write-Warning "[g] graphify step skipped: $($_.Exception.Message)"
}

# h. Ponytail (installed by default; -NoPonytail skips it; non-fatal)
$PonytailInstalled = $false
if (-not $NoPonytail) {
    try {
        Invoke-Checked 'claude' @('plugin', 'marketplace', 'add', 'DietrichGebert/ponytail')
        Invoke-Checked 'claude' @('plugin', 'install', 'ponytail@ponytail', '--scope', 'user')
        $PonytailInstalled = $true
        # The Claude CLI cannot pin a plugin version, so check the one actually installed.
        $ponyVersions = @(Get-ChildItem -Path (Join-Path $env:USERPROFILE '.claude\plugins\cache\ponytail\ponytail') -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
        if ($ponyVersions -contains $PonytailVersion) {
            Write-Step 'h' "Ponytail plugin installed (user scope), version $PonytailVersion as tested"
        } else {
            Write-Warning "[h] Ponytail installed version is '$($ponyVersions -join ', ')', not the tested $PonytailVersion. The CLI cannot pin plugin versions; review the update before relying on it."
        }
    } catch {
        Write-Warning "[h] Ponytail install failed, skipped: $($_.Exception.Message)"
    }
} else {
    Write-Step 'h' 'Ponytail skipped (-NoPonytail)'
}

# i. Launcher
Set-Content -Path (Join-Path $Bin 'claude-stack.cmd') -Encoding ASCII -Value @(
    '@echo off',
    'node "%USERPROFILE%\.token-stack\bin\claude-stack.mjs" %*'
)
Write-Step 'i' 'Wrote claude-stack.cmd launcher'

# j. RTK hook. The hook calls 'rtk' by its bare name, so bin must be on the user PATH first.
#    rtk's init runs from the state folder so no rtk data folder is created in a project.
$RtkHookActive = $false
$RtkHookAttempted = $false
$PathAdded = $false
if (-not $NoRtkHook) {
    # Recorded before 'rtk init' runs: if it fails half-way, uninstall still tries to clean up.
    $RtkHookAttempted = $true
    try {
        $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
        if (-not (($userPath -split ';') -contains $Bin)) {
            $newPath = $userPath.TrimEnd(';')
            if ($newPath) { $newPath += ';' }
            [Environment]::SetEnvironmentVariable('Path', ($newPath + $Bin), 'User')
            $PathAdded = $true
        }
        $env:Path = $env:Path + ';' + $Bin
        Push-Location -Path $State
        try {
            & $RtkExe init -g --auto-patch | Out-Host
            if ($LASTEXITCODE -eq 0) { $RtkHookActive = $true } else { Write-Warning "[j] rtk init exited with code $LASTEXITCODE; the RTK hook is not active." }
        } finally { Pop-Location }
        if ($RtkHookActive) { Write-Step 'j' 'RTK hook active in Claude Code (settings.json, RTK.md, CLAUDE.md @RTK.md line); bin added to user PATH' }
    } catch {
        Write-Warning "[j] RTK hook step skipped: $($_.Exception.Message)"
    }
} else {
    Write-Step 'j' 'RTK hook skipped (-NoRtkHook): executable only, no settings or CLAUDE.md change'
}

# k2. How to start
Write-Step 'k2' 'Start Claude Code through the stack with: %USERPROFILE%\.token-stack\bin\claude-stack.cmd (open a new terminal first if PATH changed)'

# k. Model split for sub-agents, in the user's CLAUDE.md (every new session reads it)
& (Join-Path $PSScriptRoot 'set-orchestration.ps1')
Write-Step 'k' 'Model split for sub-agents written to %USERPROFILE%\.claude\CLAUDE.md'

# Automatic routing: every Claude Code session uses the stack (variable + logon task). -NoAuto skips it.
$AutoEnabled = $false
if (-not $NoAuto) {
    try {
        & (Join-Path $PSScriptRoot 'auto.ps1') -Enable
        $AutoEnabled = $true
        Write-Step 'm' 'Automatic routing on: new Claude Code sessions go through the stack; logon task keeps it running'
    } catch {
        Write-Warning "[m] Automatic routing not enabled: $($_.Exception.Message). Use claude-stack.cmd manually."
    }
} else {
    Write-Step 'm' 'Automatic routing skipped (-NoAuto)'
}

# l. Manifest. Ownership flags are merged with the previous manifest: a re-run that finds
#    something already in place (PATH entry, pxpipe, Ponytail, hook) must not give up ownership of it.
$old = $null
if (Test-Path -LiteralPath $ManifestPath) {
    try { $old = Get-Content -Raw -Path $ManifestPath | ConvertFrom-Json } catch { $old = $null }
}
$oldPxpipeOwned = [bool]($old -and $old.pxpipe -and $old.pxpipe.owned)
$manifest = [ordered]@{
    installedAt   = (Get-Date).ToString('s')
    binFiles      = $BinFiles
    rtk           = $true
    rtkHook       = [bool]($RtkHookAttempted -or ($old -and $old.rtkHook))
    pathAdded     = [bool]($PathAdded -or ($old -and $old.pathAdded))
    headroom      = [ordered]@{ venv = 'headroom' }
    graphify      = [ordered]@{ venv = 'graphify'; registered = [bool]($GraphifyRegistered -or ($old -and $old.graphify -and $old.graphify.registered)); project = $GraphifyProjectUsed }
    pxpipe        = [ordered]@{ npm = 'pxpipe-proxy'; owned = [bool]($PxpipeOwned -or $oldPxpipeOwned) }
    ponytail      = [bool]($PonytailInstalled -or ($old -and $old.ponytail))
    orchestration = $true
    autoRouting   = [bool]($AutoEnabled -or ($old -and $old.autoRouting))
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $ManifestPath -Encoding UTF8
Write-Step 'l' "Wrote install manifest: $ManifestPath"
Write-Host 'Done.'
