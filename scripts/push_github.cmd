@echo off
setlocal
cd /d "%~dp0.."
where git >nul 2>nul || (echo Install Git for Windows first & exit /b 1)
where gh >nul 2>nul || (echo Install GitHub CLI: winget install GitHub.cli & exit /b 1)
if "%~1"=="" (set "REPO=opportunity-radar-api") else (set "REPO=%~1")
if not exist .git git init -b main
git add .
git commit -m "Initial NestJS Docker PostgreSQL starter"
if errorlevel 1 echo No changes or missing git user.name/user.email. Check git status.
gh repo create "%REPO%" --private --source=. --remote=origin --push
if errorlevel 1 (echo Repo creation failed. Check gh auth login, or existing origin. & exit /b 1)
echo ------
echo Published to GitHub. Now create Neon DB and Render Blueprint.
