@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Lingee OpenAPI Console

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%~dp0start.js" %*
goto done

:nonode
echo.
echo   [ERROR] Node.js not found.
echo   Please install Node 18+ from https://nodejs.org/
echo   then run this file again.
echo.
pause
exit /b 1

:done
echo.
echo   Server stopped.
pause
