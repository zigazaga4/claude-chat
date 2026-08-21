#!/usr/bin/env bash
#
# Publish claude chat over HTTPS at https://<this-host>.<tailnet>.ts.net
#
#   ./scripts/expose.sh public    reachable from the open internet (funnel)
#   ./scripts/expose.sh tailnet   reachable only from your tailnet (serve)
#   ./scripts/expose.sh off       not reachable from either
#   ./scripts/expose.sh status    show the current config
#
# The two modes publish the SAME URL and differ only in who can reach it:
#
#   tailnet  `tailscale serve` — the listener exists only on the Tailscale
#            interface. Devices have to be signed into your tailnet. Nothing
#            on the public internet can see that the port exists.
#
#   public   `tailscale funnel` — Tailscale publishes real public DNS records
#            and relays traffic in. Anyone who knows or guesses the hostname
#            reaches the login page, so the password is the ONLY thing between
#            the internet and an app that can spawn shells as this user.
#            That is a deliberate trade: convenience of not having to enrol
#            every device, paid for by leaning entirely on the password.
#
# Tailscale terminates TLS and forwards to 127.0.0.1:$PORT, which is also why
# the app's gate never trusts a loopback source address: after this proxy hop,
# a request from a phone in another country and a request from this laptop
# look identical at the socket.

set -uo pipefail

PORT="${PORT:-3002}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale is not installed or not on PATH." >&2
  exit 1
fi

host() {
  tailscale status --json 2>/dev/null | python3 -c \
    'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null
}

# Writing serve config is root-only until the operator is delegated once with
# `sudo tailscale set --operator=$USER`.
#
# The escalation is deliberately staged, because this also runs from pm2 at
# boot where there is no terminal: a bare `sudo` there would sit waiting for a
# password that nobody can type, and hang startup indefinitely. So try
# unprivileged first, and only fall back to an *interactive* sudo when there
# genuinely is a terminal; otherwise use `sudo -n`, which fails instead of
# prompting.
# Run a tailscale subcommand, escalating only as far as it has to.
ts() {
  if tailscale "$@" 2>/dev/null; then return 0; fi
  [ "$(id -u)" -eq 0 ] && return 1
  if [ -t 0 ] && [ -t 1 ]; then
    sudo tailscale "$@"
  else
    sudo -n tailscale "$@" 2>/dev/null
  fi
}

# funnel and serve write the same 443 config slot, so switching between them
# means clearing the other first — otherwise "public" can silently stay
# tailnet-only, or worse, "tailnet" can leave a funnel running.
clear_all() {
  ts funnel --https=443 off >/dev/null 2>&1
  ts serve --https=443 off >/dev/null 2>&1
  return 0
}

require_certs() {
  if ! tailscale status --json 2>/dev/null | python3 -c \
      'import json,sys; sys.exit(0 if json.load(sys.stdin).get("CertDomains") else 1)' 2>/dev/null; then
    echo "tailscale: HTTPS certificates are not enabled for this tailnet." >&2
    echo "  Enable them at https://login.tailscale.com/admin/dns -> HTTPS Certificates" >&2
    return 1
  fi
}

# Shown when escalation was refused. Non-fatal by design: this runs from pm2 at
# boot, and losing the tunnel must never mean losing the app on localhost too.
no_permission() {
  echo "tailscale: could not change the tunnel without a password prompt." >&2
  echo "  Grant it once, then it works unattended forever:" >&2
  echo "    sudo tailscale set --operator=\$USER" >&2
}

case "${1:-status}" in
  public|funnel)
    require_certs || exit 1
    clear_all
    if ts funnel --bg "$PORT"; then
      echo "Public on: https://$(host)"
      echo "Anyone on the internet who reaches that URL gets the login page."
      echo "The password is the only thing protecting it."
    else
      no_permission; exit 1
    fi
    ;;
  tailnet|serve|on)
    require_certs || exit 1
    clear_all
    if ts serve --bg "$PORT"; then
      echo "Serving on: https://$(host)"
      echo "Reachable only from devices signed into this tailnet."
    else
      no_permission; exit 1
    fi
    ;;
  off)
    if clear_all; then
      echo "Stopped. Reachable only from this machine's own network now."
    fi
    ;;
  status)
    tailscale serve status
    ;;
  *)
    echo "usage: $0 {public|tailnet|off|status}" >&2
    exit 2
    ;;
esac
