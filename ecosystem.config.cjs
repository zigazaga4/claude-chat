// pm2 ecosystem file. Usage:
//   pm2 start ecosystem.config.cjs           # production (next start)
//   pm2 start ecosystem.config.cjs --only claude-chat-dev   # dev (next dev)
//   pm2 restart claude-chat
//   pm2 logs claude-chat

const PORT = 3002;

module.exports = {
  apps: [
    {
      name: 'cloudchat',
      cwd: __dirname,
      // Run the launcher directly instead of `npm run start`. Going through npm
      // leaves two supervisors resident for the life of the app — npm itself at
      // ~10 MB and the `sh -c` it spawns at ~1.3 MB — that do nothing after
      // boot but forward signals. start.sh already ends in `exec`, so pm2 still
      // tracks the real server pid either way.
      script: 'scripts/start.sh',
      interpreter: 'bash',
      env: { PORT: String(PORT), NODE_ENV: 'production' },
      max_restarts: 5,
      autorestart: true,
      // Catch a genuine runaway, but stay clear of legitimate spikes. This has
      // to sit above the worst *correct* allocation and below the heap cap in
      // start.sh, because a restart here is violent: it kills in-flight streams
      // and orphans any OpenCode server they had spawned, at ~350 MB each. The
      // measured worst case is repairTranscript on the largest transcript on
      // this machine — parsing costs 4.55x file size, so 231 MB of JSONL needs
      // about 1051 MB. A tighter limit would turn that into a restart loop.
      max_memory_restart: '1400M',
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
