#!/usr/bin/env bash
#
# Schedules a one-off run window for perpl-bot using cron, in UTC.
#
#   ./scripts/schedule-window.sh                              # this weekend (Sat 08:00 -> Sun 23:59 UTC)
#   ./scripts/schedule-window.sh "2026-08-22 08:00" "2026-08-23 23:59"
#   ./scripts/schedule-window.sh --clear                      # remove a pending schedule
#   ./scripts/schedule-window.sh --show                       # print current entries
#
# Why cron and not MAX_RUNTIME_HOURS: pm2 restarts the bot on crash, which would
# reset an internal runtime clock and let the run spill past the window. An
# external stop at a wall-clock time holds regardless of how many restarts
# happened in between.
#
# Linux only (needs GNU `date -d`). Run it on the VPS, not on macOS.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MARKER="#perpl-window"
CRON_LOG="/var/log/perpl-cron.log"

show() { crontab -l 2>/dev/null | grep -F "$MARKER" || echo "(no perpl-bot window scheduled)"; }
clear_entries() { crontab -l 2>/dev/null | grep -vF "$MARKER" | crontab - || true; }

case "${1:-}" in
  --show)  show; exit 0 ;;
  --clear) clear_entries; echo "Cleared."; show; exit 0 ;;
esac

START_AT="${1:-$(date -u -d 'next Saturday' +%Y-%m-%d) 08:00}"
STOP_AT="${2:-$(date -u -d 'next Sunday' +%Y-%m-%d) 23:59}"

# cron has a near-empty PATH and no nvm, so every binary must be absolute and
# node's dir prepended - tsx/pm2 shell out to `node` by bare name.
PM2="$(command -v pm2 || true)"
NODE="$(command -v node || true)"
[ -n "$PM2" ]  || { echo "pm2 not found in PATH. npm install -g pm2" >&2; exit 1; }
[ -n "$NODE" ] || { echo "node not found in PATH." >&2; exit 1; }
NODE_DIR="$(dirname "$NODE")"

# Cron fires on the box's own clock. Rather than rely on `CRON_TZ=UTC` (whose value
# would swallow the trailing marker comment, silently leaving the entry on local
# time), resolve the UTC wall-clock time to an epoch and render the cron fields in
# the box's local zone. Correct whether or not the VPS is set to UTC.
to_cron() { date -d "@$(date -u -d "$1" +%s)" "+%M %H %d %m"; }   # min hour day month
START_CRON="$(to_cron "$START_AT")"
STOP_CRON="$(to_cron "$STOP_AT")"

start_epoch=$(date -u -d "$START_AT" +%s)
stop_epoch=$(date -u -d "$STOP_AT" +%s)
now_epoch=$(date -u +%s)
(( stop_epoch > start_epoch ))  || { echo "Stop time is not after start time." >&2; exit 1; }
(( start_epoch > now_epoch ))   || echo "WARNING: start time is in the past - it will not fire this year." >&2

hours=$(( (stop_epoch - start_epoch) / 3600 ))
mins=$(( ((stop_epoch - start_epoch) % 3600) / 60 ))

clear_entries
{
  crontab -l 2>/dev/null || true
  echo "$START_CRON * cd $REPO_DIR && PATH=$NODE_DIR:\$PATH $PM2 startOrRestart ecosystem.config.cjs >> $CRON_LOG 2>&1 $MARKER"
  # stop-window.sh does the whole safe stop: pm2 stop, wait for the process to be
  # really down, cancel every working order, close every open position, verify the
  # account is flat (ntfy alert if not), and pm2 save so a reboot's `pm2 resurrect`
  # won't relaunch it. Then delete these entries so the window doesn't repeat next year.
  echo "$STOP_CRON * cd $REPO_DIR && PATH=$NODE_DIR:\$PATH ./scripts/stop-window.sh >> $CRON_LOG 2>&1; crontab -l | grep -vF '$MARKER' | crontab - $MARKER"
} | crontab -

chmod +x "$REPO_DIR/scripts/stop-window.sh"

echo "Scheduled:"
echo "  start  $(date -u -d "$START_AT" '+%a %Y-%m-%d %H:%M') UTC  =  $(date -d "@$start_epoch" '+%a %Y-%m-%d %H:%M %Z') box time"
echo "  stop   $(date -u -d "$STOP_AT"  '+%a %Y-%m-%d %H:%M') UTC  =  $(date -d "@$stop_epoch"  '+%a %Y-%m-%d %H:%M %Z') box time  (stops, then cancels orders + closes positions)"
echo "  window ${hours}h ${mins}m"
echo "  dir    $REPO_DIR"
echo "  log    $CRON_LOG"
echo
show
