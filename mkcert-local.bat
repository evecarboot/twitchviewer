@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
set "MKCERT_EXIT=0"

echo.
echo  Twitchviewer - trusted local HTTPS (mkcert)
echo  --------------------------------------------
echo.

call :FindMkcert
if defined MKCERT_EXE goto :HaveMkcert

echo [INFO] mkcert not found in PATH and not in usual install folders.
echo.
choice /c YN /m "Install mkcert now with winget (recommended on Windows 10/11)"
if errorlevel 2 goto :MkcertMissing
where winget >nul 2>&1
if errorlevel 1 (
  echo [ERROR] winget is not available. Install mkcert manually (see below^).
  goto :MkcertMissing
)
echo.
winget install --id FiloSottile.mkcert -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo [ERROR] winget install failed.
  goto :MkcertMissing
)
echo.
echo Installed. Searching for mkcert.exe (PATH may not update until a new terminal opens^)...
call :FindMkcert
if not defined MKCERT_EXE (
  echo.
  echo Close this window, open a NEW Command Prompt or PowerShell, cd to this folder, run mkcert-local.bat again.
  set "MKCERT_EXIT=1"
  goto :WaitAndExit
)

:HaveMkcert
echo Using: %MKCERT_EXE%
echo.

if not exist "certs" mkdir "certs"

echo [1/2] Installing local CA into this PC (trusted by Chrome/Edge^) ...
echo       If this fails, right-click this file -^> Run as administrator, then try again.
echo.
"%MKCERT_EXE%" -install
if errorlevel 1 (
  echo.
  echo [ERROR] mkcert -install failed. Run this script as Administrator once.
  echo.
  set "MKCERT_EXIT=1"
  goto :WaitAndExit
)

echo.
echo [2/2] Writing certs\localhost.pem and certs\localhost-key.pem ...
"%MKCERT_EXE%" -cert-file "certs\localhost.pem" -key-file "certs\localhost-key.pem" localhost 127.0.0.1
if errorlevel 1 (
  echo [ERROR] mkcert failed to create certificate files.
  echo.
  set "MKCERT_EXIT=1"
  goto :WaitAndExit
)

if not exist "certs\localhost.pem" (
  echo [ERROR] certs\localhost.pem missing after mkcert.
  echo.
  set "MKCERT_EXIT=1"
  goto :WaitAndExit
)
if not exist "certs\localhost-key.pem" (
  echo [ERROR] certs\localhost-key.pem missing after mkcert.
  echo.
  set "MKCERT_EXIT=1"
  goto :WaitAndExit
)

echo.
echo  Done.
echo  - Restart the Node server (npm start^). Console should say: TLS: trusted (certs/localhost...
echo  - Reload https://127.0.0.1:3000 - padlock should be OK, no NET::ERR_CERT_AUTHORITY_INVALID.
echo.
echo  Still broken? Run this .bat again as Administrator (mkcert -install must install the CA).
echo  Then fully quit Edge/Chrome (all windows^) and reopen.
echo.
goto :WaitAndExit

:MkcertMissing
echo.
echo Install mkcert one of these ways, then run this script again:
echo   winget install --id FiloSottile.mkcert -e
echo   choco install mkcert
echo   Or download mkcert-windows-amd64.exe from:
echo   https://github.com/FiloSottile/mkcert/releases
echo   Rename it to mkcert.exe and put it in this folder (next to this .bat^).
echo.
set "MKCERT_EXIT=1"
goto :WaitAndExit

:FindMkcert
set "MKCERT_EXE="
for /f "delims=" %%i in ('where mkcert 2^>nul') do (
  set "MKCERT_EXE=%%i"
  exit /b 0
)
for /f "delims=" %%i in ('where mkcert.exe 2^>nul') do (
  set "MKCERT_EXE=%%i"
  exit /b 0
)
if exist "%~dp0mkcert.exe" set "MKCERT_EXE=%~dp0mkcert.exe" & exit /b 0
if exist "%ProgramData%\chocolatey\bin\mkcert.exe" set "MKCERT_EXE=%ProgramData%\chocolatey\bin\mkcert.exe" & exit /b 0
if exist "%USERPROFILE%\scoop\shims\mkcert.exe" set "MKCERT_EXE=%USERPROFILE%\scoop\shims\mkcert.exe" & exit /b 0
if exist "%USERPROFILE%\go\bin\mkcert.exe" set "MKCERT_EXE=%USERPROFILE%\go\bin\mkcert.exe" & exit /b 0
if exist "%LOCALAPPDATA%\Microsoft\WinGet\Packages" (
  for /f "delims=" %%i in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath ($env:LOCALAPPDATA + '\Microsoft\WinGet\Packages') -Filter mkcert.exe -Recurse -ErrorAction SilentlyContinue ^| Select-Object -First 1 -ExpandProperty FullName"') do (
    set "MKCERT_EXE=%%i"
    exit /b 0
  )
)
exit /b 1

:WaitAndExit
echo Press any key to close this window...
pause >nul
exit /b %MKCERT_EXIT%
