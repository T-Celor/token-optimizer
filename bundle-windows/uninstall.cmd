@echo off
rem One command: lists what will be removed, asks once, then removes it. Use -KeepData to keep the state folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 goto :end
echo.
set "CONFIRM="
set /p CONFIRM=Type YES to remove everything listed above:
if /I "%CONFIRM%"=="YES" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" -Force %*
) else (
    echo Nothing removed.
)
:end
echo.
pause
