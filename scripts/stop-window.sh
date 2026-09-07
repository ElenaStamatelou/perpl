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
#
# The one thing this must never do is flatten while the bot is still trading:
# both sides share a per-account request-id sequence, so a flatten racing a live
# bot corrupts both. It happened - `PERPL_PM2_APP=perpl` (the app is actually
# named perpl-bot) made `pm2 stop` fail with "Process or Namespace not found",
# the script shrugged that off as "already stopped", the liveness check missed
# the process too, and flatten ran against a fully live bot. Hence: a wrong app
# name is now a hard, loud failure, and liveness is decided by pm2's own pid
# plus a cwd-scoped process scan rather than a command-line pattern.
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

APP_NAME="${PERPL_PM2_APP:-perpl-bot}"

# Push + stderr. A stop that gives up must not do it quietly at 23:59 on a cron
# run; ntfy is the only channel anyone actually sees. No-op without NTFY_TOPIC.
alert() {
  local msg="$1" title="${2:-perpl stop-window FAILED}" prio="${3:-urgent}" topic
  echo "$msg" >&2
  topic="$(sed -n 's/^[[:space:]]*NTFY_TOPIC=//p' .env 2>/dev/null | tail -1 | tr -d "\"' \r")"
  [ -n "$topic" ] || return 0
  curl -fsS -H "Title: $title" -H "Priority: $prio" -H "Tags: rotating_light" \
    -d "$msg" "https://ntfy.sh/$topic" >/dev/null 2>&1 || true
}

PM2="$(command -v pm2 || true)"
if [ -z "$PM2" ]; then
  alert "stop-window ABORTED on $(hostname): pm2 is not in PATH, so the bot could not be stopped. Nothing was flattened. Check $REPO_DIR by hand."
  echo "ERROR: pm2 not found in PATH - cannot stop anything. (cron needs an absolute PATH; see schedule-window.sh)"
  exit 2
fi

# "<status> <pid>" for APP_NAME: status is online/stopped/errored/..., or
# "missing" when pm2 has no such app, or "unknown" when pm2/node could not be
# read. pid is 0 when pm2 reports none.
pm2_app_state() {
  "$PM2" jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try {
        const app = JSON.parse(s).find((a) => a.name === process.argv[1]);
        console.log(app ? `${app.pm2_env.status} ${app.pid || 0}` : "missing 0");
      } catch { console.log("unknown 0"); }
    });' "$APP_NAME"
}

pm2_names() {
  "$PM2" jlist 2>/dev/null | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => {
      try { console.log(JSON.parse(s).map((a) => a.name).join(", ") || "(no pm2 apps)"); }
      catch { console.log("(could not read pm2 list)"); }
    });'
}

# Bot processes belonging to THIS repo. The old check was `pgrep -f "tsx src/bot.ts"`,
# which is wrong twice over: it depends on how the tsx wrapper happens to spell its
# argv (it re-execs, so the pattern can miss the real process entirely), and it is
# not scoped to this checkout, so a second bot on the same box would look like ours.
# Match the entrypoint loosely, then decide ownership by cwd.
repo_bot_pids() {
  local pid cwd out=""
  for pid in $(pgrep -f "src/bot\.ts" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)"
    # No /proc (non-Linux): ownership is unknowable, so assume it is ours - the
    # safe direction is "still up", never "safe to flatten".
    if [ -z "$cwd" ] || [ "$cwd" = "$REPO_DIR" ]; then out="$out $pid"; fi
  done
  echo "${out# }"
}

still_up() {
  local state status pid
  state="$(pm2_app_state)"
  status="${state%% *}"
  pid="${state##* }"
  [ "$status" = "online" ] && return 0
  # Cannot read pm2 -> cannot prove it is down.
  [ "$status" = "unknown" ] && return 0
  [ "$pid" != "0" ] && kill -0 "$pid" 2>/dev/null && return 0
  [ -n "$(repo_bot_pids)" ] && return 0
  return 1
}

echo "=== $(date -u '+%Y-%m-%d %H:%M:%S UTC') stop-window: stopping $APP_NAME ==="

name_error=0
state="$(pm2_app_state)"
status="${state%% *}"

# A name pm2 does not know means we have stopped NOTHING. Never treat that as
# "already stopped" - that is the bug that let flatten race a live bot.
if [ "$status" = "missing" ]; then
  running="$(repo_bot_pids)"
  echo "ERROR: pm2 has no app named '$APP_NAME' - nothing was stopped."
  echo "       pm2 knows: $(pm2_names)"
  echo "       Re-run with the right name: PERPL_PM2_APP=<name> ./scripts/stop-window.sh"
  if [ -n "$running" ]; then
    echo "REFUSING to flatten: bot pid(s) [$running] are still trading from $REPO_DIR."
    echo "  Flattening against a live bot corrupts the shared per-account request-id sequence."
    alert "stop-window ABORTED on $(hostname): no pm2 app named '$APP_NAME', and bot pid(s) [$running] are STILL TRADING from $REPO_DIR. Nothing stopped, nothing flattened - stop it by hand."
    exit 2
  fi
  # Nothing is at risk, so still flatten and verify - but the run does NOT get to
  # report success: a wrong name that goes unnoticed here is the same wrong name
  # that will fail to stop a live bot next time.
  name_error=1
  echo "No bot process is running from $REPO_DIR - continuing to flatten so the account is still verified flat."
else
  if ! "$PM2" stop "$APP_NAME"; then
    echo "pm2 stop returned non-zero for an app pm2 does know (status was '$status') - continuing; the liveness wait below is the real guard."
  fi
fi

# pm2 stop returns as soon as it has signalled; the bot is allowed up to
# kill_timeout (100s) to finish its cycle. Wait for it to really be down before
# flattening.
waited=0
force_killed=0
while still_up; do
  if [ "$waited" -ge 180 ]; then
    # SIGTERM plus pm2's own SIGKILL at kill_timeout (100s) should have finished
    # this long ago. Escalate rather than either give up or flatten on top of a
    # live bot: a window that ends with the bot still trading is the worse
    # outcome, and flatten exists precisely to clean up after a hard kill.
    state="$(pm2_app_state)"
    kill_pids="$(repo_bot_pids) ${state##* }"
    echo "WARNING: $APP_NAME still alive 180s after the stop signal (state='$state') - SIGKILLing [$kill_pids]"
    for pid in $kill_pids; do
      [ "$pid" != "0" ] && kill -9 "$pid" 2>/dev/null
    done
    force_killed=1
    sleep 10
    if still_up; then
      echo "REFUSING to flatten: $APP_NAME survived SIGKILL (state='$(pm2_app_state)' pids='$(repo_bot_pids)')."
      echo "  Flattening on top of a live bot corrupts the shared per-account request-id sequence."
      alert "stop-window ABORTED on $(hostname): $APP_NAME survived SIGKILL, so the account was NOT flattened. Kill it by hand, then run: cd $REPO_DIR && npx tsx scripts/flatten.ts"
      exit 2
    fi
    echo "force-killed - a kill can strand a just-filled position, so the flatten below matters more than usual"
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

if [ "$name_error" -ne 0 ]; then
  echo "Account verified flat - but '$APP_NAME' is not a pm2 app, so this run stopped nothing."
  alert "stop-window on $(hostname): nothing was running and the account is verified flat, but there is no pm2 app named '$APP_NAME' (pm2 knows: $(pm2_names)). Fix the name in your command/cron - it will fail to stop a live bot." \
    "perpl stop-window: wrong app name" "default"
  exit 2
fi

if [ "$force_killed" -ne 0 ]; then
  alert "stop-window on $(hostname): $APP_NAME did not exit on its own and had to be SIGKILLed after 180s - the account is verified flat, but check why it hung (cd $REPO_DIR && pm2 logs $APP_NAME)." \
    "perpl stop-window: force-killed" "default"
  echo "=== stop-window complete: bot FORCE-KILLED, account verified flat ==="
  exit 0
fi

echo "=== stop-window complete: bot stopped, account verified flat ==="
