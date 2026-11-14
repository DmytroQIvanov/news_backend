@echo off
setlocal
cd /d "%~dp0.."
if not exist .env (
  copy .env.example .env >nul
  echo ------
  echo A new .env was created. Change POSTGRES_PASSWORD and INGEST_API_KEY first.
  notepad .env
  echo After saving .env, run scripts\run_local.cmd again.
  exit /b 0
)
where docker >nul 2>nul || (echo Docker Desktop / CLI missing & exit /b 1)
docker compose up -d --build || exit /b 1
docker compose ps
