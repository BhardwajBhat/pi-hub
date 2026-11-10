# pi hub

One plain-HTML chat page for Pi on all your machines. Run it on an always-on
box; open it from a phone or any laptop. Each conversation runs
`pi --mode rpc` on the machine you pick: the box itself, or a laptop over ssh.
Messages, thinking and tool results show as structured chat, not a terminal.

Python 3.8+ standard library only on the box. On every machine, only Pi.

## Setup (all Linux)

### Every machine, including the always-on box
```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh       # the box can ssh to laptops; works on college wifi
# install and log in to pi the way you already do
```
`pi` must be on PATH in a login shell (`sh -lc 'command -v pi'` should print it),
because remote conversations start it with `$SHELL -lc`.

### Always-on box
Check that ssh to each laptop works without a prompt:
```sh
ssh laptop-a true             # Tailscale hostname
```
Then install the service:
```sh
git clone https://github.com/BhardwajBhat/pi-hub ~/pi-hub
mkdir -p ~/.config/systemd/user
cp ~/pi-hub/pi-hub.service ~/.config/systemd/user/
# edit PIHUB_MACHINES in that file: your laptops' ssh host names
systemctl --user daemon-reload
systemctl --user enable --now pi-hub
sudo loginctl enable-linger $USER   # keep running after you log out
sudo tailscale serve --bg 8377      # https://<box>.<tailnet>.ts.net, tailnet-only
```
Open `https://<box>.<your-tailnet>.ts.net` on your phone (Tailscale app on) and
add it to the home screen.

To try it first without the service: `PIHUB_MACHINES="laptop-a" python3 pi-hub.py`
and open http://127.0.0.1:8377.

## Using it
- **New conversation** → name, machine, directory (`~/code/x`; empty = home).
- Ctrl/Cmd+Enter sends; Enter is a newline. **Stop** cancels the current run.
- Pi asks questions (confirm/select/input) inline in the chat.

## How it behaves
- Conversations are listed by the box (`~/.local/share/pi-hub`). Pi's own
  session file lives on the machine that runs it, under
  `~/.local/share/pi-hub/sessions`.
- Pi starts on the first message and stays running. If it stops (box restart,
  laptop asleep, wifi drop), the work in flight stops too, and the next message
  restarts Pi on that machine and resumes the same session.
- A laptop that's asleep or offline shows an ssh error when you send; send again
  once it's back.
- Run one pi hub per data directory.

## Security
Anyone who can open the page can run commands as you on every listed machine.
Keep it on localhost + `tailscale serve`. Optional extra password:
`PIHUB_USER` and `PIHUB_PASS` (HTTP basic auth).

## Settings
| variable | default | |
|---|---|---|
| `PIHUB_MACHINES` | none | ssh host names, space or comma separated |
| `PIHUB_AGENT` | `pi` | Pi command on the box |
| `PIHUB_REMOTE_AGENT` | `pi` | Pi command on the laptops |
| `PIHUB_SSH` | `ssh` | ssh command |
| `PIHUB_BIND` / `PIHUB_PORT` | `127.0.0.1` / `8377` | |
| `PIHUB_DATA_DIR` | `~/.local/share/pi-hub` | |

## Tests
```sh
python3 -m unittest -v test_chat.py
```
They use a fake Pi and a fake ssh: no model calls, credentials or network.
