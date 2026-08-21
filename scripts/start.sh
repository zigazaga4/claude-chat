#!/usr/bin/env bash
#
# What pm2 actually runs. Brings the tailnet tunnel up, then becomes the
# Next.js server.
#
# The tunnel is enabled here rather than by hand so that `pm2 restart cloudchat`
# is the single thing that has to happen for the phone to work again — there is
# no second command to forget after a reboot.
#
# Two rules this file exists to enforce:
#
#   1. A tunnel failure must never stop the app booting. Tailscale being down,
#      or the operator permission not being granted, is a reason to lose remote
#      access — not a reason to lose the app on localhost too. Hence `|| true`.
#
#   2. `exec` at the end, so the Next server *replaces* this shell rather than
#      running as its child. pm2 tracks the pid it spawned; without exec it
#      would be watching a bash wrapper, and stop/restart would leave the real
#      server orphaned and still holding the port.

set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

# Provider API keys. `next start` does not read .env.local (see
# src/server/secretSource.ts), and providers.ts takes its credentials straight
# from process.env — so without this the keys exist only when pm2 happens to
# have inherited them from an interactive shell. After a reboot it has not:
# `pm2 startup` installs a launchd job, and launchd never reads ~/.zshrc.
# Sourcing here is what makes the keys survive a restart.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

# Escape hatch for contexts that should not touch the tunnel — the Electron
# wrapper starts its own server on a random port, and enabling serve for that
# port would point the public hostname at a server that is about to disappear.
# `public` (funnel) by default — reachable without enrolling each device.
# Set CC_EXPOSE_MODE=tailnet to require tailnet membership, or `off`.
if [ "${CC_SKIP_EXPOSE:-}" != "1" ]; then
  PORT="$PORT" bash scripts/expose.sh "${CC_EXPOSE_MODE:-public}" || true
fi

# Cap the heap. Node picks a 2240 MB old-space limit on this machine, which is
# ~40% of total RAM for a server whose live heap is about 42 MB — so V8 feels no
# pressure to compact long after the box has started swapping. 1536 MB is well
# clear of the largest measured request spike (a history page at ?limit=200
# costs ~238 MB) while still cutting the ceiling by a third.
#
# Deliberately passed as an argv flag rather than via NODE_OPTIONS: NODE_OPTIONS
# is inherited by every child, and the two big children here (the Claude CLI and
# the OpenCode server) are Bun binaries running JavaScriptCore, where a V8 flag
# is at best ignored. Targeting the node process directly keeps it contained.
#
# `.bin/next` is a symlink to this same file with a `#!/usr/bin/env node`
# shebang, so invoking node explicitly changes nothing but the flags.
exec node --max-old-space-size=1536 node_modules/next/dist/bin/next start -p "$PORT"
