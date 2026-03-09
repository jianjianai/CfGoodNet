@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "SCRIPT_DIR=%~dp0"
set "CONFIG_DIR="
set "CONFIG_FILE="
for %%F in ("%SCRIPT_DIR%config\config.yml" "%SCRIPT_DIR%..\config\config.yml") do (
	if not defined CONFIG_FILE if exist "%%~fF" (
		set "CONFIG_FILE=%%~fF"
		for %%D in ("%%~dpF.") do set "CONFIG_DIR=%%~fD"
	)
)
if not defined CONFIG_FILE (
	set "CONFIG_DIR=%SCRIPT_DIR%config"
	set "CONFIG_FILE=%SCRIPT_DIR%config\config.yml"
)
set "USER_DATA_DIR=%SCRIPT_DIR%msedge"
set "PROXY_SERVER=http://127.0.0.1:3000"
set "APP_FILE=%SCRIPT_DIR%app.cjs"

if not exist "%CONFIG_FILE%" (
	if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
	call :promptCfProxy
	> "%CONFIG_FILE%" (
		echo server:
		echo   listen: 3000
		echo cfProxy: !CF_PROXY!
		echo cfGoodIp: freeyx.cloudflare88.eu.org
		echo rules:
		echo   - MATCH,cfProxy
	)

	echo Created default config file: "%CONFIG_FILE%"
)
if exist "%CONFIG_FILE%" (
	echo Using config file: "%CONFIG_FILE%"
)

where node >nul 2>nul
if errorlevel 1 (
	echo Node.js is not installed. Please install Node.js 22 or newer.
	goto end
)

for /f "usebackq tokens=*" %%v in (`node -v 2^>nul`) do set "NODE_VERSION_RAW=%%v"
if not defined NODE_VERSION_RAW (
	echo Failed to detect Node.js version. Please reinstall Node.js 22 or newer.
	goto end
)

for /f "tokens=1 delims=." %%m in ("%NODE_VERSION_RAW:v=%") do set "NODE_MAJOR=%%m"
if not defined NODE_MAJOR (
	echo Failed to parse Node.js version "%NODE_VERSION_RAW%".
	goto end
)

set /a NODE_MAJOR_NUM=NODE_MAJOR+0 >nul 2>nul
if errorlevel 1 (
	echo Invalid Node.js version "%NODE_VERSION_RAW%".
	goto end
)

if %NODE_MAJOR_NUM% LSS 22 (
	echo Node.js version %NODE_VERSION_RAW% detected. Please upgrade to Node.js 22 or newer.
	goto end
)

call :findBrowser
if defined BROWSER_EXE (
	if not exist "%USER_DATA_DIR%" mkdir "%USER_DATA_DIR%"
	start "" "%BROWSER_EXE%" --user-data-dir="%USER_DATA_DIR%" --proxy-server="%PROXY_SERVER%" --ignore-certificate-errors
	echo Browser started: "%BROWSER_EXE%"
) else (
	echo No supported browser found. Install Edge/Chrome/Brave/Chromium/Opera.
)

if not exist "%APP_FILE%" (
	echo App file not found: "%APP_FILE%"
	goto end
)

echo Starting app: "%APP_FILE%"
node "%APP_FILE%"

:end
echo.
pause
exit /b

:promptCfProxy
set "CF_PROXY="
:promptCfProxyLoop
echo Enter cfProxy URL (example: https://abc.com/)
set /p "CF_PROXY=cfProxy: "
if "!CF_PROXY!"=="" (
	echo cfProxy cannot be empty. Please try again.
	goto promptCfProxyLoop
)
exit /b

:findBrowser
set "BROWSER_EXE="

for /f "delims=" %%p in ('where msedge.exe 2^>nul') do (
	set "BROWSER_EXE=%%p"
	goto :eof
)

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
	set "BROWSER_EXE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
	goto :eof
)

if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
	set "BROWSER_EXE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
	goto :eof
)

if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" (
	set "BROWSER_EXE=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
	goto :eof
)

for %%b in (chrome.exe brave.exe chromium.exe opera.exe launcher.exe) do (
	for /f "delims=" %%p in ('where %%b 2^>nul') do (
		set "BROWSER_EXE=%%p"
		goto :eof
	)
)

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
	set "BROWSER_EXE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
	goto :eof
)

if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
	set "BROWSER_EXE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
	goto :eof
)

if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
	set "BROWSER_EXE=%LocalAppData%\Google\Chrome\Application\chrome.exe"
	goto :eof
)

if exist "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe" (
	set "BROWSER_EXE=%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe"
	goto :eof
)

if exist "%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe" (
	set "BROWSER_EXE=%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe"
	goto :eof
)

if exist "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe" (
	set "BROWSER_EXE=%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe"
	goto :eof
)

if exist "%LocalAppData%\Chromium\Application\chrome.exe" (
	set "BROWSER_EXE=%LocalAppData%\Chromium\Application\chrome.exe"
	goto :eof
)

if exist "%ProgramFiles%\Opera\launcher.exe" (
	set "BROWSER_EXE=%ProgramFiles%\Opera\launcher.exe"
	goto :eof
)

if exist "%ProgramFiles(x86)%\Opera\launcher.exe" (
	set "BROWSER_EXE=%ProgramFiles(x86)%\Opera\launcher.exe"
	goto :eof
)

if exist "%AppData%\Opera Software\Opera Stable\launcher.exe" (
	set "BROWSER_EXE=%AppData%\Opera Software\Opera Stable\launcher.exe"
	goto :eof
)

goto :eof
