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
- **skills/publish-page/** — tells pi how to build pages (phone-first, pi rc's plain
  look, what works in the sandbox) and publish them; includes an HTML template.
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
- Messages from the web go into the same session. If pi is busy they steer it:
  pi gets them as soon as its current tool calls finish. **Stop** on the web is the same as Escape in the terminal.
- `/rc` shows status and the link · `/rc off` / `/rc on` for the current session.
- A session is listed while its pi is running and online.

## Pages (like artifacts)
Ask pi for something to look at ("make a page comparing the runs", "publish the
report") and it loads the bundled `publish-page` skill, writes HTML in the same
plain style as pi rc, and calls its `publish_page` tool. You get a link like
`https://pi-rc.<you>.workers.dev/a/<random-id>/`, shown in the chat.

- A single `.html` file, or a folder with `index.html` plus its CSS/JS/images/data
  (max 300 files, 20 MB; `node_modules`, `.git` and dotfiles are skipped).
- Publishing the same path again from the same session updates the same link.
- Anyone with the link can view it, so it's easy to share. Pages run sandboxed: no
  localStorage or cookies, and no access to your token or sessions.
- `/rc pages` lists them, `/rc unpublish <id>` deletes one. They're stored in the
  relay (Durable Object SQLite; the free plan allows 5 GB in total).

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
