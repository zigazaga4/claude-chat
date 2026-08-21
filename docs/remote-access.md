# Reaching claude chat from your phone

The app runs on the laptop. The phone is just a browser pointed at it over
Tailscale. Nothing is deployed anywhere, and nothing is exposed to the public
internet.

## Why it is set up this way

This app can start shells, read and write files, and SSH out to other machines,
all as the user running the server. An unauthenticated request to it is a
remote shell. So there are two independent locks, and both have to fail before
anything is at risk:

1. **Network** — `tailscale serve` binds the listener to the tailnet only.
   A device that is not signed into your tailnet cannot see that the port
   exists. Port scans of your home IP find nothing.
2. **Password** — every request that is not on a short exemption list needs a
   valid session cookie, checked in `src/proxy.ts` before any route runs.

The second lock matters even though the first looks sufficient: it covers the
case where a tailnet device is lost, borrowed, or already compromised.

### Why there is no "trust localhost" shortcut

Tailscale terminates TLS and forwards to `127.0.0.1:3002`. After that hop a
request from a phone on mobile data and a request typed on the laptop itself
are indistinguishable at the socket level. A rule like "skip auth for loopback"
would therefore exempt exactly the remote traffic the gate exists to check.
There is no source-IP exemption anywhere in the gate, deliberately.

## One-time setup

**1. Put your phone on the tailnet.** Install the Tailscale app (iOS or
Android), sign in with the same account as the laptop, and confirm the phone
shows up at <https://login.tailscale.com/admin/machines>.

**2. Start serving.** On the laptop:

```bash
npm run expose          # asks for your sudo password once
```

It prints the URL, which is stable and never changes:

```
https://leo-ideapad-3-17aba7.tail2f347a.ts.net
```

Serving survives reboots — `--bg` persists the config in tailscaled. To check
or undo it:

```bash
npm run expose:status
npm run expose:off
```

Delegating the operator once removes the sudo prompt from future calls:

```bash
sudo tailscale set --operator=$USER
```

**3. Open the URL on the phone**, enter the password, and add it to the home
screen. It installs as a standalone PWA (see `src/app/manifest.ts`) and runs
without browser chrome.

## The password

It is read at runtime from, in order:

1. `APP_PASSWORD` in the process environment, if it is actually exported.
2. `~/.claude-chat/app-password` (mode `0600`) — **this is the one in use.**

> **`.env.local` does not work for this.** `next start` in this project does
> not load that file into the process environment. It was verified by booting
> the built server with the ambient variables stripped and watching the gate
> report no password configured. The API keys in `.env.local` appear to work
> only because they are *also* exported from the shell that starts pm2 — worth
> knowing if those ever go missing after a reboot.

To change it:

```bash
printf '%s\n' 'your-new-password' > ~/.claude-chat/app-password
chmod 600 ~/.claude-chat/app-password
```

It takes effect within five seconds, no restart needed. Changing it also signs
out every device, because the session signature is bound to a fingerprint of
the password.

Sessions last 30 days per device. The cookie is `HttpOnly`, `SameSite=Lax`,
and `Secure` whenever the request arrived over HTTPS — which it always does
through Tailscale. Log out from the icon in the top bar.

Failed logins are throttled to 8 per 10 minutes per source address, and the
throttle applies even to a correct password once tripped.

## What is deliberately not gated

Three things bypass the password, each for a concrete reason:

| Path | Why |
| --- | --- |
| `/api/mcp/*` | A locally-spawned OpenCode child process calls this over loopback and holds no cookie. It authenticates with a per-turn UUID in the path. Gating it silently strips the notebook, SSH, and vision tools from every turn — the model just finds the tools missing. |
| `/_next/static`, `/_next/image` | Build output, no secrets. Gating it would break the login page's own stylesheet. |
| `/manifest.webmanifest`, `/icon-*.png` | Browsers fetch these without credentials when installing the PWA. |

## If you ever need it on the open internet

`tailscale funnel` puts the same URL on the public internet, at which point the
password is the only thing between the world and a shell on the laptop. It is
not wired into these scripts on purpose. If you genuinely need it — a borrowed
phone, a locked-down work laptop — turn it on deliberately and turn it back off
after:

```bash
sudo tailscale funnel --bg 3002
sudo tailscale funnel --https=443 off
```
