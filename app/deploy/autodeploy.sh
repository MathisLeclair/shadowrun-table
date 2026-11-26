#!/usr/bin/env bash
# Auto-deploy: run every minute by shadowrun-autodeploy.timer on the VPS.
# If origin/main moved: snapshot the game data, rebuild, health-check, roll back the code if the new build is unhealthy.
# Wrapped in main() so bash parses the whole file before `git reset` can rewrite it mid-run.
main() {
  set -euo pipefail
  local REPO="$HOME/shadowrun" BACKUPS="$HOME/shadowrun-backups" FAILED="$HOME/.shadowrun-failed-commit"
  local URL="http://127.0.0.1:8095/api/health"
  exec 9>/tmp/shadowrun-autodeploy.lock
  flock -n 9 || exit 0
  cd "$REPO"
  git fetch -q origin main
  local OLD NEW
  OLD=$(git rev-parse HEAD)
  NEW=$(git rev-parse origin/main)
  [ "$OLD" = "$NEW" ] && exit 0
  if [ -f "$FAILED" ] && [ "$(cat "$FAILED")" = "$NEW" ]; then exit 0; fi # this commit already failed: wait for the next push
  echo "[autodeploy] ${OLD:0:7} -> ${NEW:0:7}"

  mkdir -p "$BACKUPS"
  tar -czf "$BACKUPS/runtime-$(date +%Y%m%d-%H%M%S)-${OLD:0:7}.tgz" -C "$REPO/app" runtime
  ls -1t "$BACKUPS"/runtime-*.tgz | tail -n +11 | xargs -r rm -f

  docker image tag shadowrun-app:latest shadowrun-app:previous 2>/dev/null || true
  git reset -q --hard "$NEW"
  cd "$REPO/app"
  if docker compose up -d --build --remove-orphans >/tmp/shadowrun-build.log 2>&1 && wait_healthy "$URL"; then
    echo "[autodeploy] OK ${NEW:0:7}: $(git -C "$REPO" log -1 --format=%s)"
    rm -f "$FAILED"
    docker image prune -f --filter label=app=shadowrun-table >/dev/null 2>&1 || true
  else
    echo "[autodeploy] FAILED ${NEW:0:7}, rolling back to ${OLD:0:7}"
    tail -n 30 /tmp/shadowrun-build.log || true
    echo "$NEW" >"$FAILED"
    git -C "$REPO" reset -q --hard "$OLD"
    if docker image inspect shadowrun-app:previous >/dev/null 2>&1; then
      docker image tag shadowrun-app:previous shadowrun-app:latest
      docker compose up -d --no-build
    else
      docker compose up -d --build
    fi
    wait_healthy "$URL" && echo "[autodeploy] rollback healthy" || echo "[autodeploy] rollback NOT healthy, check: docker logs shadowrun"
    exit 1
  fi
}

wait_healthy() {
  for _ in $(seq 1 45); do
    if curl -fsS --max-time 3 "$1" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 4
  done
  return 1
}

main "$@"
