@echo off
rem LoadPilot one-step build: double-click to build both executables and both
rem installers. The installers end up in installer\dist.
rem Extra option: build.bat -SkipNpmInstall   (reuse node_modules, works offline)
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build.ps1" -OpenFolder %*
set "rc=%ERRORLEVEL%"
echo.
if "%rc%"=="0" (echo Done - the installers are in installer\dist.) else (echo Build failed - read the red message above.)
pause
exit /b %rc%
