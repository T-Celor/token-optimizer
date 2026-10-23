<#
Automatic routing: every Claude Code session uses the stack.
  -Enable   points Claude Code at the stack (the "env" block of ~/.claude/settings.json and the user variable
            ANTHROPIC_BASE_URL), registers the startup app "TokenStackServe" that keeps the chain running
            (claude-stack.mjs --serve), and starts it now. No administrator rights are needed.
  -Disable  undoes all of it and stops the running chain. Values the user set themselves are left alone.
The startup app is listed in Settings > Apps > Startup and in Task Manager > Startup apps, where it can be
turned off. It runs with no window (conhost --headless).
Usage: powershell -ExecutionPolicy Bypass -File bundle-windows\auto.ps1 -Enable | -Disable
Needs no API key: Claude Code keeps using the claude.ai login; the proxies only forward it.
#>
param(
    [switch]$Enable,
    [switch]$Disable
)

$ErrorActionPreference = 'Stop'

$State      = Join-Path $env:USERPROFILE '.token-stack'
$Bin        = Join-Path $State 'bin'
$Stack      = Join-Path $Bin 'claude-stack.mjs'
$ServePs1   = Join-Path $Bin 'serve.ps1'
$ServePid   = Join-Path $State 'serve.pid'
$RunKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$AppName    = 'TokenStackServe'
$FrontUrl   = 'http://127.0.0.1:47831'
$StackPorts = @(47831, 47830, 47821, 8787)
# Entries written by earlier versions of this script, removed on enable and disable.
$StartupDir    = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$LegacyEntries = @((Join-Path $StartupDir 'TokenStackServe.vbs'), (Join-Path $StartupDir 'TokenStackServe.cmd'))

function Get-UserEnv([string]$Name) { [Environment]::GetEnvironmentVariable($Name, 'User') }

function Remove-LegacyEntries {
    foreach ($p in $LegacyEntries) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force; Write-Host "Removed: old startup entry $(Split-Path -Leaf $p)" }
    }
}

# taskkill writes to stderr when the process is already gone; under ErrorActionPreference Stop,
# PowerShell 5.1 turns that into a terminating error even when stderr is discarded.
function Stop-Tree([int]$ProcessId) {
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null } finally { $ErrorActionPreference = $saved }
}

# The command Windows runs at logon. conhost --headless (Windows 10 1809 and later) runs the
# console with no window at all; older systems fall back to a hidden PowerShell window.
function Get-ServeCommand {
    $ps = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$ServePs1`""
    if ([Environment]::OSVersion.Version.Build -ge 17763) { return "conhost.exe --headless $ps" }
    return "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ServePs1`""
}

function Stop-Serve {
    if (Test-Path -LiteralPath $ServePid) {
        Stop-Tree ([int](Get-Content -Raw -LiteralPath $ServePid).Trim())
        Remove-Item -LiteralPath $ServePid -Force -ErrorAction SilentlyContinue
        Write-Host 'Stopped: running stack (serve)'
    }
    # A serve process missing from serve.pid (an older run) would restart the proxies stopped below.
    $serves = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'claude-stack\.mjs.*--serve' } | Select-Object -ExpandProperty ProcessId)
    foreach ($id in $serves) { Stop-Tree $id }
    if ($serves.Count -gt 0) { Write-Host "Stopped: $($serves.Count) other serve process(es)" }
    # Proxies can outlive the serve process that started them, so also stop the stack's own processes
    # still listening on its ports. Only ours: another program on the same port is left alone.
    $owners = @(Get-StackListeners)
    foreach ($owner in $owners) { Stop-Tree $owner }
    if ($owners.Count -gt 0) { Write-Host "Stopped: $($owners.Count) stack process(es) still listening on the stack ports" }
}

# Processes listening on the stack ports that are part of the stack (by command line).
function Get-StackListeners {
    $ids = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $StackPorts -contains $_.LocalPort } | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($id in $ids) {
        if (-not $id -or $id -eq $PID) { continue }
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue).CommandLine
        if ($cmd -match 'context-gate\.mjs|claude-stack\.mjs|headroom|pxpipe') { $id }
    }
}

if ($Enable -and $Disable) { throw 'Use either -Enable or -Disable, not both.' }

if ($Enable) {
    if (-not (Test-Path -LiteralPath $Stack)) { throw "claude-stack.mjs is missing from $Bin. Run install.cmd first." }
    $node = (Get-Command node -ErrorAction Stop).Source

    Set-Content -LiteralPath $ServePs1 -Encoding ASCII -Value @(
        "`$ErrorActionPreference = 'Stop'",
        "& '$node' '$Stack' --serve"
    )

    Remove-LegacyEntries
    Set-ItemProperty -Path $RunKey -Name $AppName -Value (Get-ServeCommand)

    # Claude Code applies the settings.json env block itself, so the desktop app needs no Windows env
    # refresh; the user variable covers other new processes.
    & $node $Stack --settings-env set $FrontUrl
    if ($LASTEXITCODE -ne 0) { throw 'Could not write the env block of settings.json (see the message above).' }
    [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $FrontUrl, 'User')

    # One chain only: stop what is running, then start it the way Windows will at logon.
    Stop-Serve
    Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'start', '""', (Get-ServeCommand)) -WindowStyle Hidden
    Write-Host "Enabled: Claude Code goes through the stack ($FrontUrl); startup app '$AppName' keeps it running."
    Write-Host 'Quit and reopen the Claude desktop app to pick it up.'
    exit 0
}

if ($Disable) {
    if (Test-Path -LiteralPath $Stack) {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        if ($nodeCmd) { & $nodeCmd.Source $Stack --settings-env unset $FrontUrl }
    } else {
        Write-Warning "Could not check settings.json: remove ANTHROPIC_BASE_URL from its env block by hand if it is $FrontUrl."
    }
    if ((Get-UserEnv 'ANTHROPIC_BASE_URL') -eq $FrontUrl) {
        [Environment]::SetEnvironmentVariable('ANTHROPIC_BASE_URL', $null, 'User')
        Write-Host 'Removed: ANTHROPIC_BASE_URL (user)'
    } elseif (Get-UserEnv 'ANTHROPIC_BASE_URL') {
        Write-Warning 'ANTHROPIC_BASE_URL is set to another value; left unchanged.'
    }
    if (Get-ItemProperty -Path $RunKey -Name $AppName -ErrorAction SilentlyContinue) {
        Remove-ItemProperty -Path $RunKey -Name $AppName
        Write-Host "Removed: startup app '$AppName'"
    }
    Remove-LegacyEntries
    Stop-Serve
    if (Test-Path -LiteralPath $ServePs1) { Remove-Item -LiteralPath $ServePs1 -Force }
    exit 0
}

Write-Host 'Nothing done. Use -Enable or -Disable.'
