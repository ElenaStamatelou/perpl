#!/usr/bin/env bash
#
# The stop half of a scheduled window (also usable by hand: ./scripts/stop-window.sh).
#
# `pm2 stop` alone is NOT a safe stop. It sends SIGTERM, the bot finishes its
# in-flight cycle, and pm2 SIGKILLs it after kill_timeout - so a cycle that is
# stuck chasing a maker fill (or a fill that lands during the kill) can leave a
# resting order or an open position behind. That is exactly how a position was
# left open overnight. So: stop the process, wait for it to actually be down,
# then cancel every working order and close every open position, and only report
# success once the account is verified flat.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PM2="$(command -v pm2 || echo pm2)"
APP_NAME="${PERPL_PM2_APP:-perpl-bot}"

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') stop-window: stopping $APP_NAME ==="
"$PM2" stop "$APP_NAME" || echo "pm2 stop returned non-zero (app may already be stopped) - continuing"

# pm2 stop returns as soon as it has signalled; the bot is allowed up to
# kill_timeout (100s) to finish its cycle. Wait for it to really be down before
# flattening: two processes on one account share a per-account request-id
# sequence, so a flatten racing a live bot can corrupt both sides' orders.
still_up() {
  pgrep -f "tsx src/bot.ts" >/dev/null 2>&1 && return 0
  [ "$("$PM2" jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const app = JSON.parse(s).find((a) => a.name === process.argv[1]);
        console.log(app ? app.pm2_env.status : "missing");
      } catch { console.log("unknown"); }
    });' "$APP_NAME")" = "online" ]
}

waited=0
while still_up; do
  if [ "$waited" -ge 180 ]; then
    echo "WARNING: $APP_NAME still looks alive after 180s - flattening anyway"
    break
  fi
  sleep 5
  waited=$((waited + 5))
done
echo "bot down after ${waited}s"

# Flatten, with retries: an exchange hiccup on the first pass should not be the
# difference between a flat account and an overnight position.
flattened=1
for attempt in 1 2 3; do
  echo "--- flatten attempt $attempt/3 ---"
  if npx tsx scripts/flatten.ts; then
    flattened=0
    break
  fi
  sleep 10
done

"$PM2" save >/dev/null 2>&1 || true

if [ "$flattened" -ne 0 ]; then
  echo "STOP INCOMPLETE: could not verify the account is flat - check it by hand:"
  echo "  npx tsx scripts/check-live-state.ts"
  exit 1
fi

echo "=== stop-window complete: bot stopped, account verified flat ==="
