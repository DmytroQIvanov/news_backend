@echo off
setlocal
cd /d "%~dp0.."
title Database and Backend KeepAlive (Every 10 min)
echo ====================================================
echo Запуск фонового пінгера бази даних (кожні 10 хвилин)
echo ====================================================
python scripts\ping_keepalive.py --interval 600
pause
