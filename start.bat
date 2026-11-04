@echo off
chcp 65001 >nul
cd /d "%~dp0"
title WebGate
node server.js
echo.
echo Server da dung. Nhan phim bat ky de dong cua so.
pause >nul
