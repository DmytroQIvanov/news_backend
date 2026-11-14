@echo off
setlocal
cd /d "%~dp0.."
title AI News Real-Time Poller (Every 1 Minute)
echo =======================================================
echo Запуск автоматичного опитування новин (раз на хвилину)
echo =======================================================
python scripts\poll_news_every_minute.py --interval 60
pause
