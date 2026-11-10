# pi rc

Remote control for [pi](https://pi.dev): use `pi` in your terminal as usual, then
follow and continue the same session from your phone or any browser.

```
laptop: pi + rc extension ──┐
desktop: pi + rc extension ─┼──► relay (free Cloudflare Worker) ◄── phone / browser
```

- **extension/** — a pi extension. Each pi session connects out to the relay,
  streams what happens, and accepts messages typed on the web as if you typed
  them in the terminal. Works on any network that allows HTTPS (college wifi too).
- **relay/** — a Cloudflare Worker + Durable Object that passes messages between
  pi sessions and browsers, and serves the web page. It stores nothing.

## Setup

### 1. Deploy the relay (once)
Needs a free Cloudflare account; you get a `https://pi-rc.<you>.workers.dev` URL.
```sh
cd relay
npm install
npx wrangler login
npx wrangler deploy
openssl rand -hex 24 | npx wrangler secret put TOKEN   # note this token
```

### 2. On each machine with pi
```sh
pi install git:github.com/BhardwajBhat/pi-hub
```
Then inside pi, once:
```
/rc setup https://pi-rc.<you>.workers.dev <token>
```
It saves to `~/.pi/agent/pi-rc.json` and prints the web link
(`https://…/#token=…`). Open that on your phone and add it to the home screen.

## Use
- Start `pi` anywhere; the session shows up on the web page (footer: `rc ●`).
- Messages from the web go into the same session. If pi is busy they queue as a
  follow-up. **Stop** on the web is the same as Escape in the terminal.
- `/rc` shows status and the link · `/rc off` / `/rc on` for the current session.
- A session is listed while its pi is running and online.

## Security
Anyone with the token can send messages to your pi sessions, which can run
commands on your machines. Keep the token private (it's in the web link).
Rotate it with `npx wrangler secret put TOKEN` and `/rc setup` again.
Traffic is HTTPS but not end-to-end encrypted: Cloudflare can see it.

## Develop
```sh
cd relay && echo TOKEN=test > .dev.vars && npx wrangler dev
PI_RC_URL=http://127.0.0.1:8787 PI_RC_TOKEN=test pi -e ./extension/rc.ts
# open http://127.0.0.1:8787/#token=test
```
