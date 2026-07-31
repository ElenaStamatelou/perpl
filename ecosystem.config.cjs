// pm2 process manager config - keeps the bot running unattended (auto-restart
// on crash, auto-start on VPS reboot via `pm2 startup` + `pm2 save`).
//
// Setup:  npm install -g pm2
// Start:  npm run pm2:start
// Logs:   npm run pm2:logs
// Status: npm run pm2:status
// Stop:   npm run pm2:stop
module.exports = {
  apps: [
    {
      name: "perpl-bot",
      script: "./node_modules/.bin/tsx",
      args: "src/bot.ts",
      env: { DOTENV_CONFIG_PATH: ".env" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      // pm2 sends SIGTERM on `pm2 stop`/restart, then SIGKILL after kill_timeout
      // if the process hasn't exited. bot.ts finishes the in-flight cycle before
      // exiting (up to ~10 chase attempts x 8s on a stuck open leg), so the
      // default 1.6s would get SIGKILLed mid-cycle - long enough to cover that,
      // short enough not to hang a deploy/restart indefinitely.
      kill_timeout: 100_000,
    },
  ],
};
