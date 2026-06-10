// pm2 ecosystem file. Usage:
//   pm2 start ecosystem.config.cjs           # production (next start)
//   pm2 start ecosystem.config.cjs --only claude-chat-dev   # dev (next dev)
//   pm2 restart claude-chat
//   pm2 logs claude-chat

const PORT = 3002;

module.exports = {
  apps: [
    {
      name: 'claude-chat',
      cwd: __dirname,
      script: 'npm',
      args: 'run start',
      env: { PORT: String(PORT), NODE_ENV: 'production' },
      max_restarts: 5,
      autorestart: true,
    },
    {
      name: 'claude-chat-dev',
      cwd: __dirname,
      script: 'npm',
      args: 'run dev',
      env: { PORT: String(PORT) },
      autorestart: false,
    },
  ],
};
