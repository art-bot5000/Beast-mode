#!/bin/sh
set -e

# Boot Deno backend on :8000. Permissions are least-privilege:
# - read app code + data volume; write only the data volume
# - net + env for Runware/Google/Dropbox calls and Fly secrets (RUNWARE_API_KEY,
#   R2 creds, admin secret, email provider key, etc.)
deno run \
  --unstable-kv \
  --unstable-cron \
  --allow-net \
  --allow-env \
  --allow-read=/app,/data \
  --allow-write=/data \
  /app/main.ts &

DENO_PID=$!

# Wait for Deno to answer /ping before starting Caddy (avoids 502s on cold boot).
i=0
while [ $i -lt 20 ]; do
  if curl -sf http://localhost:8000/ping > /dev/null 2>&1; then
    echo "Deno ready."
    break
  fi
  sleep 0.5
  i=$((i+1))
done

caddy run --config /app/Caddyfile --adapter caddyfile &
CADDY_PID=$!

wait $DENO_PID
