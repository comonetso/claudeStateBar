@echo off
rem browser-check for PowerShell and cmd (the Bash tool uses bin/browser-check).
node "%~dp0..\scripts\browser-check.mjs" %*
