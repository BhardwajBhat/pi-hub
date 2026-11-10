# pi hub setup (all Linux)

The default page is a minimal HTML chat: a conversation sidebar, structured
user/assistant messages, expandable thinking and tool results, and a composer.
It uses Pi's JSONL RPC mode, not terminal screen scraping. Python's standard
library is the only server dependency; the chat needs JavaScript in the browser.

## Quick start

Install and authenticate Pi first, then run from this repository:

```sh
python3 pi-hub.py
# open http://127.0.0.1:8377
```

Create a conversation, choose its local working directory, and send a message.
Ctrl/Cmd+Enter sends; Enter inserts a newline. Stop cancels the active run.
Chat sessions start on the first message and use your installed Pi configuration
and credentials. `PIHUB_AGENT` must be a Pi executable/command supporting RPC
(e.g. `PIHUB_AGENT='/absolute/path/to/pi --model provider/model'`).

Conversations and Pi session files live under `~/.local/share/pi-hub` (override
with `PIHUB_DATA_DIR`). They survive dashboard restarts and resume on the next
message. Browser reloads do not stop active work. Stopping the dashboard does
stop its chat processes; in-flight work does not outlive a server restart.
Run only one dashboard process against a given data directory.

The original `hc` dashboard is preserved at `/terminals`, including remote
machines and keyboard controls. **New structured chats are local only**; existing
`hc` terminal sessions are not automatically imported or converted to chats.
`hc` is not needed for the chat page, only for the terminal dashboard below.

Keep this service on localhost or a trusted tailnet. It can run tools with your
user's permissions. Optional `PIHUB_USER` and `PIHUB_PASS` enable Basic auth when
both are set; use HTTPS for access beyond localhost.

## Every machine (laptops + always-on box)
```
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh          # Tailscale SSH: the hub can ssh in, no keys to manage
curl -fsSL https://releases.herdr.dev/core/install.sh | sh   # herdr-core -> ~/.local/bin/hc
# install pi the way you already do (it must be on PATH)
sudo loginctl enable-linger $USER   # hc's server keeps running after you log out
```
Make sure `pi` is on PATH for non-interactive ssh (e.g. ~/.local/bin, not only set in .bashrc after the "interactive" check).

## Always-on box only
```
hc machine add laptop-a          # Tailscale hostname; repeat per machine
hc machine add laptop-b
hc ls                            # should list terminals from all machines

mkdir -p ~/pi-hub ~/.config/systemd/user
cp pi-hub.py chat.py chat.html ~/pi-hub/
cp pi-hub.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-hub
sudo tailscale serve --bg 8377   # https://<box>.<tailnet>.ts.net, tailnet-only
```
Open `https://<box>.<your-tailnet>.ts.net` on your phone (with the Tailscale app on).
Add it to the home screen for an app-like icon.

## Using the terminal dashboard (`/terminals`)
- Start pi on any machine from the "new pi session" form, or from a terminal: `hc run --bg pi`.
  (Started from a laptop, it shows up on the hub because the hub lists that laptop's terminals.)
- On a laptop keyboard, `hc attach <addr>` takes over the same session in a real terminal; ctrl+\ detaches.
- Optional password on top of Tailscale: set PIHUB_USER and PIHUB_PASS in the service file.

## Tests

```sh
python3 -m unittest -v test_chat.py
```

Tests use a fake RPC process; they make no model calls and need no credentials.
