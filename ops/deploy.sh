#!/usr/bin/env bash
# One-command (re)deploy of the hosted stack. Run on the server from anywhere:
#   ops/deploy.sh            # pull main, build, migrate, restart, health-check
#   FORCE=1 ops/deploy.sh    # also inside the nightly settlement window
#
# Secrets are never in the repository: ops/.env (SITE_ADDRESS,
# POSTGRES_PASSWORD, SETTLEMENT_INTERNAL_TOKEN, WEBHOOK_SECRET_ENCRYPTION_KEY)
# and ops/.env.docker (from .env.docker.example) must already exist.
#
# Settlement safety: the daemon closes the previous business day shortly
# after Asia/Bahrain midnight (SETTLEMENT_DAEMON_RUN_DELAY_MINUTES, 15).
# Every batch is one Postgres transaction and the daemon finishes or rolls
# back the one in flight on SIGTERM (stop_grace_period 120s in compose), and
# a re-run of a closed day is a no-op, so a restart cannot half-settle a day.
# This script still refuses to deploy between 00:00 and 01:00 Bahrain time
# so the nightly run is not interrupted at all, unless FORCE=1.
set -euo pipefail

cd "$(dirname "$0")/.."
C="docker compose -f ops/docker-compose.yml"
if ! docker info >/dev/null 2>&1; then C="sudo $C"; fi

for f in ops/.env ops/.env.docker; do
  [ -f "$f" ] || { echo "deploy: $f is missing (see ops/README.md)"; exit 1; }
done

hour=$(TZ=Asia/Bahrain date +%H)
if [ "$hour" = "00" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "deploy: it is $(TZ=Asia/Bahrain date +%H:%M) in Bahrain, inside the nightly settlement window; retry after 01:00 or set FORCE=1"
  exit 1
fi

echo "deploy: updating code"
git pull --ff-only

echo "deploy: building images"
$C build

echo "deploy: database migrations"
$C up -d postgres
$C run --rm migrate

echo "deploy: restarting services"
$C up -d proxy api settlement reporting

echo "deploy: waiting for the API to report healthy"
for _ in $(seq 1 30); do
  status=$($C ps --format '{{.Service}} {{.Health}}' | awk '$1=="api"{print $2}')
  [ "$status" = "healthy" ] && break
  sleep 2
done
$C ps
site=$(grep -E '^SITE_ADDRESS=' ops/.env | cut -d= -f2-)
curl -fsk "https://${site:-localhost}/healthz" && echo && echo "deploy: done"
