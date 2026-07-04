@echo off
:: awaykit — remove the LAN firewall rule (undo of allow-lan-windows.bat).
:: Double-click this file and approve the UAC prompt. Your phone will no
:: longer be able to reach the daemon until you run allow-lan-windows.bat again.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="awaykit (LAN 4517)"
echo.
echo Removed. awaykit is no longer reachable from your LAN.
echo.
pause
