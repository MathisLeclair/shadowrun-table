#!/usr/bin/env bash
# Entry point of the GitHub Actions deploy (.github/workflows/deploy.yml).
# The Action's SSH key is pinned to this script in ~/.ssh/authorized_keys (command="…",no-pty,…), so that key can
# only start a deploy of what is already on origin/main: no shell, no other command.
# autodeploy.sh runs in its own session and writes to a log file, so a dropped SSH connection never kills a deploy
# halfway (or its rollback); this script streams the log back and returns the deploy's exit code.
# Wrapped in main() so bash parses the whole file before the deploy's `git reset` can rewrite it.
main() {
  local LOG="/tmp/shadowrun-ci-deploy.log"
  : >"$LOG"
  setsid /bin/bash "$HOME/shadowrun/app/deploy/autodeploy.sh" >"$LOG" 2>&1 </dev/null &
  local pid=$!
  tail -n +1 -f --pid="$pid" "$LOG"
  wait "$pid"
}

main "$@"
