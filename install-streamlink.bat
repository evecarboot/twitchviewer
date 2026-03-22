@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo.
echo  Twitchviewer - install Streamlink (for Twitch as HLS / muted autoplay)
echo  -----------------------------------------------------------------------
echo.

where streamlink >nul 2>&1
if not errorlevel 1 (
  echo streamlink is already on PATH:
  where streamlink
  echo.
  echo Restart your Node server — startup should say streamlink detected.
  goto :WaitAndExit
)

echo streamlink not found on PATH. Trying common installers...
echo.

where winget >nul 2>&1
if not errorlevel 1 (
  echo [winget] Installing Streamlink...
  winget install --id Streamlink.Streamlink -e --accept-package-agreements --accept-source-agreements
  if not errorlevel 1 (
    echo.
    echo winget install finished. Open a NEW Command Prompt and run: where streamlink
    goto :WaitAndExit
  )
  echo winget failed or package id changed — try manual install below.
  echo.
)

where py >nul 2>&1
if not errorlevel 1 (
  echo [pip] py -m pip install --user streamlink
  py -m pip install --user -U streamlink
  echo.
  echo If that worked, add Python Scripts to PATH, or set STREAMLINK_PATH in .env to:
  for /f "delims=" %%i in ('py -c "import sysconfig; print(sysconfig.get_path('scripts'))" 2^>nul') do echo   %%i\streamlink.exe
  goto :WaitAndExit
)

where python >nul 2>&1
if not errorlevel 1 (
  echo [pip] python -m pip install --user streamlink
  python -m pip install --user -U streamlink
  goto :WaitAndExit
)

echo Could not install automatically.
echo.
echo Manual options:
echo   1. https://streamlink.github.io/install.html#windows
echo   2. pip install streamlink  (then set STREAMLINK_PATH in .env if PATH is still wrong^)
echo.

:WaitAndExit
echo.
echo Press any key to close...
pause >nul
exit /b 0
