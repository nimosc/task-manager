@echo off
setlocal

set FILE=%~dp0index.html
set PROFILE=%TEMP%\taskmanager-chrome-profile
set FILE_URL=file:///%FILE:\=/%

REM Try common Chrome locations
set CHROME=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe

if "%CHROME%"=="" (
    echo Chrome not found. Opening with default browser instead.
    echo Note: Claude AI feature will not work without Chrome.
    start "" "%FILE%"
    goto end
)

echo Opening Task Manager with Chrome...
start "" "%CHROME%" --disable-web-security --allow-file-access-from-files --user-data-dir="%PROFILE%" "%FILE_URL%"

:end
endlocal
