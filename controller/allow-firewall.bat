@echo off
rem Allow other PCs (agents) to reach the LoadPilot controller through Windows Firewall.
rem Run this ONCE on the controller PC, as Administrator (right-click > Run as administrator).
rem Only needed on the controller machine; agents need no firewall changes.

net session >nul 2>&1
if errorlevel 1 (
  echo This must be run as Administrator.
  echo Right-click allow-firewall.bat and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo Allowing inbound TCP port 4000 for LoadPilot...
netsh advfirewall firewall delete rule name="LoadPilot Controller" >nul 2>&1
netsh advfirewall firewall add rule name="LoadPilot Controller" dir=in action=allow protocol=TCP localport=4000 profile=any
echo.
echo Done. Agents on other PCs can now connect to this controller on port 4000.
echo (If they still don't appear, the two PCs may be on networks that can't reach
echo  each other - check that the agent PC can open http://THIS-PC-IP:4000 in a browser.)
echo.
pause
