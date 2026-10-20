@echo off
rem browser_check ego relay entry - a server runs this over ssh:
rem   ssh <pc> "\"<dir>\entry.cmd\" <timeout-ms>"   with the complete ego-browser script on stdin
rem   ssh <pc> "\"<dir>\entry.cmd\" health"
rem The token stays in this folder; it never travels in the command or the message.
setlocal
if not exist "%~dp0port" ( echo {"ok":false,"why":"relay not running - no port file"} & exit /b 3 )
set /p T=<"%~dp0token"
set /p P=<"%~dp0port"
if /i "%~1"=="health" (
  "%SystemRoot%\System32\curl.exe" -s -S --max-time 10 -H "x-bc-token: %T%" "http://127.0.0.1:%P%/health"
  exit /b %ERRORLEVEL%
)
set TO=%~1
if "%TO%"=="" set TO=300000
"%SystemRoot%\System32\curl.exe" -s -S --max-time 1900 -H "x-bc-token: %T%" -H "x-bc-timeout: %TO%" --data-binary @- "http://127.0.0.1:%P%/run"
exit /b %ERRORLEVEL%
