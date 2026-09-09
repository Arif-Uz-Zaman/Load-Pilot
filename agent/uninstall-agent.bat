@echo off
setlocal
title LoadPilot Agent - remove / stop permanently
echo ============================================================
echo  Removing the LoadPilot agent's auto-start from THIS PC
echo ============================================================
echo.

rem --- 1) Old style: the scheduled task created by install-service.bat ---
schtasks /Query /TN "LoadPilotAgent" >nul 2>&1
if %errorlevel%==0 (
  echo Removing scheduled task "LoadPilotAgent" ...
  schtasks /Delete /F /TN "LoadPilotAgent" >nul 2>&1
  if %errorlevel%==0 (echo   done.) else (echo   FAILED - re-run this file as Administrator.)
) else (
  echo No scheduled task "LoadPilotAgent" found.
)

rem --- 2) New style: Startup-folder shortcuts created by the installer ---
echo Removing Startup shortcuts ...
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\LoadPilot Agent*.lnk" >nul 2>&1

rem --- 3) Stop the running agent(s) now ---
echo Stopping running agent(s) ...
taskkill /F /IM loadpilot-agent.exe >nul 2>&1

echo.
echo ============================================================
echo  Done. The agent will NOT come back after restart.
echo  (If the scheduled-task line said FAILED, right-click this
echo   file and choose "Run as administrator", then run again.)
echo ============================================================
echo.
pause
