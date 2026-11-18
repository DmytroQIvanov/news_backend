#!/bin/sh
# Safe deploy on the server: build a candidate image, switch to it, wait for /health, roll back on failure.
# Usage (in ~/app, after uploading sources):  sh deploy/safe-deploy.sh
set -u
cd "$(dirname "$0")/.."
COMPOSE="sudo docker compose --env-file .env.server -f compose.lean.yaml"

$COMPOSE config -q || { echo "compose configuration is invalid (compose.lean.yaml / .env.server)"; exit 1; }

# 1. remember the image of the running container (immutable id) as the recovery point
RUNNING_ID=$(sudo docker inspect -f '{{.Image}}' "$($COMPOSE ps -q api 2>/dev/null | head -n1)" 2>/dev/null || true)
[ -n "$RUNNING_ID" ] && sudo docker tag "$RUNNING_ID" news-api:recovery

# 2. build a candidate under its own tag; latest is untouched until the candidate passes static checks
sudo docker build -t news-api:candidate . > ../build-api.log 2>&1 || { echo "build failed"; tail -20 ../build-api.log; exit 1; }
sudo docker run --rm --entrypoint sh news-api:candidate -c "test -f /app/knowledge/kb/quotas.v1.json && test -f /app/dist/main.js" \
  || { echo "candidate image is incomplete (quotas.v1.json or dist/main.js missing)"; exit 1; }
CANDIDATE_ID=$(sudo docker image inspect -f '{{.Id}}' news-api:candidate)

# 3. switch and verify the RUNNING container uses the candidate and answers /health
sudo docker tag news-api:candidate news-api:latest
$COMPOSE up -d api >/dev/null 2>&1 || echo "warning: compose up returned an error"
wait_healthy() {
  for i in $(seq 1 30); do
    code=$(curl -s -m 10 -o /dev/null -w "%{http_code}" localhost:3000/api/v1/health)
    [ "$code" = "200" ] && return 0
    sleep 8
  done
  return 1
}
IMG_NOW=$(sudo docker inspect -f '{{.Image}}' "$($COMPOSE ps -q api | head -n1)" 2>/dev/null || true)
if [ "$IMG_NOW" = "$CANDIDATE_ID" ] && wait_healthy; then
  echo "healthy on the new image"
  exit 0
fi

# 4. roll back to the recovery image and verify that too (database migrations are not undone)
echo "new image failed (running=$IMG_NOW expected=$CANDIDATE_ID): rolling back"
if sudo docker image inspect news-api:recovery >/dev/null 2>&1; then
  sudo docker tag news-api:recovery news-api:latest
  $COMPOSE up -d api >/dev/null 2>&1
  if wait_healthy; then echo "rolled back and healthy"; else echo "ROLLBACK ALSO UNHEALTHY"; fi
else
  echo "no recovery image available"
fi
exit 1
