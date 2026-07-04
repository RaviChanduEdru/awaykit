@echo off
:: awaykit — allow the phone on your LAN to reach the daemon (Windows).
:: Double-click this file. It will ask for Administrator (UAC), then add a
:: firewall rule that opens TCP 4517 to your local subnet ONLY.
::
:: Undo later with:  scripts\deny-lan-windows.bat

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting Administrator permission...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set PORT=4517
netsh advfirewall firewall delete rule name="awaykit (LAN %PORT%)" >nul 2>&1
netsh advfirewall firewall add rule name="awaykit (LAN %PORT%)" dir=in action=allow protocol=TCP localport=%PORT% remoteip=localsubnet profile=any

echo.
set LANIP=
for /f "delims=" %%i in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 ^| Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } ^| Sort-Object InterfaceMetric ^| Select-Object -First 1 -ExpandProperty IPAddress"') do set LANIP=%%i
if "%LANIP%"=="" set LANIP=192.168.x.x

echo ============================================================
echo  Done. Your phone can now reach awaykit on the same Wi-Fi:
echo.
echo      http://%LANIP%:%PORT%
echo.
echo  (That is your laptop's current Wi-Fi IP. If it changes,
echo   use the "phone:" URL the daemon prints on startup.)
echo ============================================================
echo.
pause
