@echo off
setlocal
title LoadPilot agent installer
rem ============================================================
rem  LoadPilot agent - install so it always runs in the background
rem  Usage:  install-service.bat [http://CONTROLLER-IP:4000]
rem  Double-clicking works - it will ask for the URL.
rem
rem  With Administrator rights -> boot task as SYSTEM (invisible,
rem  starts even before login). Without admin -> logon task for the
rem  current user (starts minimized at login). Both survive closing
rem  any windows and restart with the PC.
rem ============================================================

set "URL=%~1"
if "%URL%"=="" (
  echo =============================================
  echo  LoadPilot agent - install as startup service
  echo =============================================
  echo.
  set /p URL="Enter controller URL (e.g. http://192.168.2.156:4000): "
)
if "%URL%"=="" (
  echo No URL given - nothing installed.
  pause
  exit /b 1
)

if not exist "%~dp0loadpilot-agent.exe" (
  echo loadpilot-agent.exe was not found next to this script.
  echo Put install-service.bat and loadpilot-agent.exe in the same folder.
  pause
  exit /b 1
)

rem Save the URL into config.json territory by doing one silent first run? Not
rem needed - the URL is part of the task command line below.

net session >nul 2>&1
if errorlevel 1 goto :userTask

rem ---- Open the agent control port (4101) so a controller can redirect this
rem      agent to a new controller PC ("Point all agents here"). ----
netsh advfirewall firewall delete rule name="LoadPilot Agent Control" >nul 2>&1
netsh advfirewall firewall add rule name="LoadPilot Agent Control" dir=in action=allow protocol=TCP localport=4101 >nul 2>&1

rem ---- Administrator: invisible SYSTEM task, starts at boot ----
schtasks /Create /F /TN "LoadPilotAgent" ^
  /TR "\"%~dp0loadpilot-agent.exe\" %URL% --no-stub" ^
  /SC ONSTART /RU SYSTEM /RL HIGHEST
if errorlevel 1 (
  echo Failed to create the boot task.
  pause
  exit /b 1
)
schtasks /Run /TN "LoadPilotAgent" >nul
echo.
echo Installed as a BOOT task (invisible, runs before anyone logs in).
goto :done

:userTask
rem ---- No admin: logon task for this user (minimized window) ----
echo.
echo No Administrator rights - installing as a LOGON task for this user
echo instead. The agent starts (minimized) every time you log in.
echo For an invisible boot-time install, re-run this as Administrator.
echo.
schtasks /Create /F /TN "LoadPilotAgent" ^
  /TR "cmd /c start /min \"LoadPilot agent\" \"%~dp0loadpilot-agent.exe\" %URL% --no-stub" ^
  /SC ONLOGON
if errorlevel 1 (
  echo Failed to create the logon task.
  pause
  exit /b 1
)
schtasks /Run /TN "LoadPilotAgent" >nul
echo Installed as a LOGON task.

:done
echo.
echo =============================================
echo  This PC should appear in the LoadPilot web
echo  UI (Agents tab) within a few seconds.
echo.
echo  To remove later:
echo    schtasks /Delete /F /TN "LoadPilotAgent"
echo =============================================
echo.
pause
