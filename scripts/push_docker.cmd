@echo off
setlocal
cd /d "%~dp0.."
if "%~1"=="" (echo Usage: scripts\push_docker.cmd DOCKERHUB_USERNAME & exit /b 1)
where docker >nul 2>nul || (echo Docker CLI missing & exit /b 1)
docker login || exit /b 1
docker build -t "%~1/opportunity-radar-api:latest" . || exit /b 1
docker push "%~1/opportunity-radar-api:latest" || exit /b 1
echo ------
echo Pushed image: %~1/opportunity-radar-api:latest
