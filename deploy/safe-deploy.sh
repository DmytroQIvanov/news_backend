#!/bin/sh
# Safe deploy on the server: build, restart, wait for /health, roll back to the previous image on failure.
# Usage (in ~/app, after uploading sources):  sh deploy/safe-deploy.sh
set -u
cd "$(dirname "$0")/.."
COMPOSE="sudo docker compose --env-file .env.server -f compose.lean.yaml"
if sudo docker image inspect news-api:latest >/dev/null 2>&1; then sudo docker tag news-api:latest news-api:previous; fi
sudo docker build -t news-api:latest . > ../build-api.log 2>&1 || { echo "build failed"; tail -20 ../build-api.log; exit 1; }
# the image must contain the quota file and start; check without touching the running container
sudo docker run --rm --entrypoint sh news-api:latest -c "test -f /app/knowledge/kb/quotas.v1.json" || { echo "image is missing quotas.v1.json"; exit 1; }
$COMPOSE up -d api >/dev/null 2>&1
for i in $(seq 1 30); do
  code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" localhost:3000/api/v1/health)
  [ "$code" = "200" ] && { echo "healthy after $((i*8))s"; exit 0; }
  sleep 8
done
echo "health check failed: rolling back"
if sudo docker image inspect news-api:previous >/dev/null 2>&1; then
  sudo docker tag news-api:previous news-api:latest
  $COMPOSE up -d api >/dev/null 2>&1
fi
exit 1
