@echo off
rem One command: installs the whole Token Optimization Stack for the current user.
rem Extra switches are passed through, for example: install.cmd -NoPonytail
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
