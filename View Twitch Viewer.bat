@echo off
setlocal EnableExtensions
cd /d "%~dp0"

call :EnsureNode
if errorlevel 1 exit /b 1

echo.
echo Ensuring npm packages are installed ^(may take a few seconds^)...
call npm install
if errorlevel 1 (
  echo npm install failed. Check the messages above.
  pause
  exit /b 1
)

echo.
echo Starting the viewer...
start "Twitch viewer" cmd /k "cd /d %~dp0 && node server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3000/"
exit /b 0

:EnsureNode
where node >nul 2>nul
if not errorlevel 1 (
  exit /b 0
)

echo.
echo Node.js was not found on this PC.
echo This viewer needs Node.js ^(includes npm^) to run on your machine.
echo.

REM Try Windows Package Manager (Windows 10/11)
where winget >nul 2>nul
if not errorlevel 1 (
  echo Installing Node.js LTS using winget...
  echo If Windows asks for permission, please approve so Node can be installed.
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo winget could not install Node.js automatically.
    goto TryChoco
  )
  call :RefreshNodePath
  where node >nul 2>nul
  if not errorlevel 1 (
    echo Node.js is ready.
    exit /b 0
  )
  echo Node was installed but is not on PATH yet in this window. Trying common install locations...
  call :RefreshNodePath
  where node >nul 2>nul
  if not errorlevel 1 (
    echo Node.js is ready.
    exit /b 0
  )
  goto ManualNode
)

:TryChoco
where choco >nul 2>nul
if not errorlevel 1 (
  echo Trying Chocolatey to install Node.js LTS...
  choco install nodejs-lts -y
  if errorlevel 1 (
    goto ManualNode
  )
  call :RefreshNodePath
  where node >nul 2>nul
  if not errorlevel 1 (
    echo Node.js is ready.
    exit /b 0
  )
)

:ManualNode
echo.
echo Automatic install did not complete. Please install Node.js yourself, then run this file again.
echo A download page will open in your browser ^(choose the LTS installer for Windows^).
echo.
pause
start "" "https://nodejs.org/en/download/"
exit /b 1

:RefreshNodePath
REM Typical paths so this same window can find node.exe right after install
set "PATH=%ProgramFiles%\nodejs;%ProgramFiles(x86)%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%PATH%"
exit /b 0
