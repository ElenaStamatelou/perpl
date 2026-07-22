#!/usr/bin/env bash
# Creates .env.<label> from .env.example for running an additional account
# (different wallet) side by side with the default .env. Never overwrites.
#
# Usage: scripts/new-account.sh account2
set -euo pipefail

LABEL="${1:?Usage: scripts/new-account.sh <label>   e.g. scripts/new-account.sh account2}"
TARGET=".env.$LABEL"

if [ -f "$TARGET" ]; then
  echo "$TARGET already exists - not overwriting." >&2
  exit 1
fi

cp .env.example "$TARGET"
sed -i.bak "s/^BOT_LABEL=.*/BOT_LABEL=$LABEL/" "$TARGET" && rm -f "$TARGET.bak"

echo "Created $TARGET"
echo "Next:"
echo "  1. Fill in PERPL_API_KEY / PERPL_API_KEY_SECRET for this wallet (create at app.perpl.xyz/apikeys)"
echo "  2. Consider varying NOTIONAL_USD / CYCLE_REST_MIN_MS / CYCLE_REST_MAX_MS from your other accounts"
echo "  3. Sanity check:  DOTENV_CONFIG_PATH=$TARGET npx tsx scripts/check-connection.ts"
echo "  4. Add it to ecosystem.config.cjs to run it under pm2"
