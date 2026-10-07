@echo off
title LoadPilot agent updater
rem ============================================================
rem  One-double-click agent updater. Keeps the EXISTING agent
rem  name(s), count, and controller URL from the previous install.
rem
rem  HOW TO USE: put this file, update-agent.ps1, and the NEW
rem  loadpilot-agent.exe in the same folder on a worker PC and
rem  double-click this. It self-elevates and runs the updater.
rem ============================================================

if not exist "%~dp0update-agent.ps1" (
  echo ERROR: update-agent.ps1 not found next to this script.
  echo Keep update-agent.bat, update-agent.ps1, and loadpilot-agent.exe together.
  pause
  exit /b 1
)

rem need admin for the SYSTEM startup task + firewall; self-elevate if not.
net session >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0update-agent.ps1\"'"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update-agent.ps1"
