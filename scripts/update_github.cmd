@echo off
setlocal
cd /d "%~dp0.."
where git >nul 2>nul || (echo Git missing & exit /b 1)
git add -A
git diff --cached --quiet
if not errorlevel 1 (echo No changes. & exit /b 0)
git commit -m "Update Opportunity Radar API" || exit /b 1
git push || exit /b 1
echo ------
echo GitHub updated. Render auto-deploy will run if configured.
