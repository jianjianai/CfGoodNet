@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM 切换到脚本所在目录
cd /d "%~dp0"

echo ========================================
echo 启动 Node.js 应用 app.cjs
echo 然后启动浏览器，配置代理到本地 3000
echo 浏览器关闭后，Node.js 将自动停止
echo ========================================

REM 检查 node 是否可用
where node >nul 2>&1
if errorlevel 1 (
    echo 错误: 未找到 node 命令，请确保 Node.js 已安装并添加到 PATH。
    pause
    exit /b 1
)

REM 检查 app.cjs 是否存在
if not exist "app.cjs" (
    echo 错误: 当前目录下未找到 app.cjs 文件。
    pause
    exit /b 1
)

REM 检查配置文件 config\config.yml
if not exist "config\config.yml" goto :create_config
goto :after_config

:create_config
echo 未找到配置文件 config\config.yml，需要生成。

REM 创建 config 目录（如果不存在）
if not exist config mkdir config

REM 必须填写 cfProxy URL，无默认值
:input_proxy
set /p cfproxy=请输入 cfProxy 的 URL (例如 https://proxy.abc.cn/): 
if "!cfproxy!"=="" (
    echo 输入不能为空，请重新输入。
    goto input_proxy
)

REM 生成配置文件（使用 for 安全输出用户输入，避免特殊字符导致命令截断）
echo 正在生成配置文件 config\config.yml ...
(
    echo server:
    echo   listen: 3000
) > config\config.yml
for /f "delims=" %%a in ("!cfproxy!") do >> config\config.yml echo cfProxy: %%a
(
    echo cfGoodIp: freeyx.cloudflare88.eu.org
    echo rules:
    echo   - MATCH,cfProxy
) >> config\config.yml

echo 配置文件已生成。
goto :after_config

:after_config
echo 启动 node app.cjs ...
start /B node app.cjs

REM 等待几秒让 Node.js 完成初始化
echo 等待服务启动...
timeout /t 3 /nobreak >nul

REM 查找可用的浏览器 (优先 Edge，其次 Chrome)
set "BROWSER="
set "BROWSER_NAME="

REM 检查 PATH 中的 msedge
for %%i in (msedge.exe) do set "BROWSER=%%~$PATH:i" 2>nul
if defined BROWSER (
    set "BROWSER_NAME=Microsoft Edge"
    goto :found_browser
)

REM 检查常见安装路径的 msedge
set "EDGE_PATHS="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" "C:\Program Files\Microsoft\Edge\Application\msedge.exe""
for %%p in (%EDGE_PATHS%) do (
    if exist %%p (
        set "BROWSER=%%~p"
        set "BROWSER_NAME=Microsoft Edge"
        goto :found_browser
    )
)

REM 检查 PATH 中的 chrome
for %%i in (chrome.exe) do set "BROWSER=%%~$PATH:i" 2>nul
if defined BROWSER (
    set "BROWSER_NAME=Google Chrome"
    goto :found_browser
)

REM 检查常见安装路径的 chrome
set "CHROME_PATHS="C:\Program Files\Google\Chrome\Application\chrome.exe" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe""
for %%p in (%CHROME_PATHS%) do (
    if exist %%p (
        set "BROWSER=%%~p"
        set "BROWSER_NAME=Google Chrome"
        goto :found_browser
    )
)

echo 错误: 未找到 Microsoft Edge 或 Google Chrome，请安装其中之一。
pause
exit /b 1

:found_browser
echo 找到浏览器: %BROWSER_NAME% (%BROWSER%)
echo 启动浏览器（使用独立用户数据目录，忽略证书错误，代理指向本地 3000）...
echo 请使用浏览器进行操作，关闭浏览器后脚本将自动退出。

REM 直接启动浏览器并等待其退出（阻塞直到浏览器关闭）
"%BROWSER%" --user-data-dir="%~dp0edgedata" --proxy-server="http://127.0.0.1:3000" --ignore-certificate-errors

REM 浏览器已关闭，清理 Node.js 进程
echo.
echo 浏览器已关闭，正在停止 Node.js 服务...
taskkill /F /IM node.exe >nul 2>&1
if errorlevel 1 (
    echo 未能关闭 Node.js 进程，请手动检查。
) else (
    echo Node.js 进程已关闭。
)

echo 脚本执行完毕，即将退出...
exit /b 0