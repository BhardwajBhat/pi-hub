# pi hub setup (all Linux)

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
cp pi-hub.py ~/pi-hub/
cp pi-hub.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-hub
sudo tailscale serve --bg 8377   # https://<box>.<tailnet>.ts.net, tailnet-only
```
Open `https://<box>.<your-tailnet>.ts.net` on your phone (with the Tailscale app on).
Add it to the home screen for an app-like icon.

## Using it
- Start pi on any machine from the "new pi session" form, or from a terminal: `hc run --bg pi`.
  (Started from a laptop, it shows up on the hub because the hub lists that laptop's terminals.)
- On a laptop keyboard, `hc attach <addr>` takes over the same session in a real terminal; ctrl+\ detaches.
- Optional password on top of Tailscale: set PIHUB_USER and PIHUB_PASS in the service file.
