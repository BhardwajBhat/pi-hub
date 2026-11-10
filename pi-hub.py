#!/usr/bin/env python3
"""pi-hub: a plain-HTML, phone-friendly web UI over herdr-core (hc).

Lists every hc terminal (this machine and every `hc machine add`-ed one),
shows its screen, lets you type into it, press keys, start new pi sessions
on any machine and kill old ones.

Python 3.8+ stdlib only. Run it on the always-on box:

    python3 pi-hub.py                    # listens on 127.0.0.1:8377
    PIHUB_BIND=100.x.y.z python3 pi-hub.py   # a Tailscale IP

Settings (environment variables):
    PIHUB_BIND    address to listen on       (default 127.0.0.1)
    PIHUB_PORT    port                       (default 8377)
    PIHUB_HC      path to hc                 (default: hc on PATH, then ~/.local/bin/hc)
    PIHUB_AGENT   command for "new session"  (default: pi)
    PIHUB_USER / PIHUB_PASS   if both set, HTTP basic auth is required
"""
import base64
import hmac
import html
import json
import os
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

BIND = os.environ.get("PIHUB_BIND", "127.0.0.1")
PORT = int(os.environ.get("PIHUB_PORT", "8377"))
HC = os.environ.get("PIHUB_HC") or shutil.which("hc") or os.path.expanduser("~/.local/bin/hc")
AGENT = os.environ.get("PIHUB_AGENT", "pi")
USER = os.environ.get("PIHUB_USER", "")
PASS = os.environ.get("PIHUB_PASS", "")

KEYS = ["enter", "esc", "tab", "up", "down", "ctrl+c", "ctrl+d", "y", "n"]


# ---------------------------------------------------------------- hc calls

def hc(*args, timeout=20):
    """Run hc with an argv list (never a shell). Returns (ok, stdout_or_error)."""
    try:
        p = subprocess.run([HC, *args], capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return False, f"hc not found at {HC}"
    except subprocess.TimeoutExpired:
        return False, "hc timed out"
    if p.returncode != 0:
        msg = (p.stderr or p.stdout).strip() or f"hc exited {p.returncode}"
        try:  # hc --json errors look like {"error":{"message":...,"hint":...}}
            e = json.loads(msg)["error"]
            msg = e.get("message", msg) + (f" ({e['hint']})" if e.get("hint") else "")
        except (ValueError, KeyError, TypeError):
            pass
        return False, msg
    return True, p.stdout


def hc_json(*args, **kw):
    ok, out = hc(*args, "--json", **kw)
    if not ok:
        return None, out
    try:
        return json.loads(out), None
    except ValueError:
        return None, out.strip()


def terminals(show_all=False):
    data, err = hc_json("ls", *(["--all"] if show_all else []))
    return (data or {}).get("terminals", []), err


def machines():
    data, _ = hc_json("machine", "ls")
    out = []
    for m in (data or {}).get("machines", []):
        out.append(m.get("name") if isinstance(m, dict) else str(m))
    return [m for m in out if m]


def screen(addr, lines=300):
    data, err = hc_json("read", addr, "--lines", str(lines))
    if data is None:
        return f"[could not read {addr}: {err}]"
    return data.get("text", "")


# ---------------------------------------------------------------- html

CSS = """
:root{color-scheme:light dark}
body{font:16px/1.4 system-ui,sans-serif;margin:0 auto;max-width:60rem;padding:12px}
h1{font-size:1.2rem;margin:.2rem 0 .8rem}
a{color:LinkText}
table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:.45rem .3rem;border-bottom:1px solid #8884;vertical-align:top}
small,.dim{opacity:.65}
pre{font:12px/1.3 ui-monospace,monospace;background:#8881;padding:8px;overflow:auto;
    height:60vh;margin:.5rem 0;white-space:pre}
form{margin:.4rem 0}
input,select,button{font:inherit;padding:.45rem .6rem}
input[type=text]{width:100%;box-sizing:border-box}
.row{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.row input[type=text]{flex:1;min-width:10rem}
.keys button{min-width:3.2rem}
.err{background:#c003;padding:.5rem;border-radius:4px}
fieldset{border:1px solid #8884;margin:1rem 0}
@media (max-width:600px){.hide-sm{display:none}}
"""


def page(title, body):
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html.escape(title)}</title><style>{CSS}</style></head>
<body>{body}</body></html>"""


def esc(s):
    return html.escape(str(s if s is not None else ""))


def term_link(addr):
    return "/t?" + urlencode({"a": addr})


def index_html(msg="", show_all=False):
    ts, err = terminals(show_all)
    ms = machines()
    rows = []
    for t in ts:
        a = t.get("address", "")
        status = t.get("status") or t.get("state", "")
        name = t.get("name") or ""
        rows.append(
            f"<tr><td><a href='{esc(term_link(a))}'>{esc(a)}</a>"
            f"{' <small>' + esc(name) + '</small>' if name else ''}</td>"
            f"<td>{esc(t.get('agent', ''))}</td><td>{esc(status)}</td>"
            f"<td class='hide-sm dim'>{esc(t.get('cwd', ''))}</td></tr>")
    table = ("<table><tr><th>terminal</th><th>program</th><th>state</th>"
             "<th class='hide-sm'>dir</th></tr>" + "".join(rows) + "</table>"
             if rows else "<p class='dim'>No terminals running.</p>")
    opts = "<option value=''>this machine</option>" + "".join(
        f"<option>{esc(m)}</option>" for m in ms)
    body = f"""
<h1>pi hub</h1>
{f"<p class='err'>{esc(msg)}</p>" if msg else ""}
{f"<p class='err'>{esc(err)}</p>" if err else ""}
{table}
<p><a href="/">refresh</a> ·
{'<a href="/">live only</a>' if show_all else '<a href="/?all=1">include finished</a>'}</p>
<fieldset><legend>new {esc(AGENT)} session</legend>
<form method="post" action="/new">
<p><label>machine<br><select name="on">{opts}</select></label></p>
<p><label>directory <small>(empty = home)</small><br>
<input type="text" name="cwd" placeholder="~/code/project" autocapitalize="off"></label></p>
<p><label>name <small>(optional, a-z 0-9 - _)</small><br>
<input type="text" name="name" autocapitalize="off"></label></p>
<p><button>start</button></p>
</form></fieldset>
<p class="dim"><small>machines: {esc(', '.join(ms) or 'none added')} ·
add one on this box with <code>hc machine add &lt;ssh-host&gt;</code></small></p>
"""
    return page("pi hub", body)


def term_html(addr):
    keys = "".join(
        f"<button name='k' value='{esc(k)}'>{esc(k)}</button>" for k in KEYS)
    a = esc(addr)
    body = f"""
<p><a href="/">&larr; all terminals</a></p>
<h1>{a}</h1>
<pre id="scr">{esc(screen(addr))}</pre>
<form method="post" action="/send" id="sendf">
<input type="hidden" name="a" value="{a}">
<div class="row"><input type="text" name="text" id="text" autocomplete="off"
 placeholder="message, then send" autocapitalize="off">
<button>send</button></div>
</form>
<form method="post" action="/keys" class="row keys">
<input type="hidden" name="a" value="{a}">{keys}
</form>
<form method="post" action="/kill" onsubmit="return confirm('Kill {a}?')">
<input type="hidden" name="a" value="{a}"><button>kill</button>
<small class="dim">· screen refreshes every 2 s</small></form>
<script>
// Optional nicety: live screen + send without reloading. Works without it too.
const pre=document.getElementById('scr'), url='/screen?a='+encodeURIComponent({json.dumps(addr)});
let stick=true; pre.addEventListener('scroll',()=>{{stick=pre.scrollTop+pre.clientHeight>=pre.scrollHeight-20}});
function bottom(){{if(stick)pre.scrollTop=pre.scrollHeight}}
bottom();
async function tick(){{try{{const r=await fetch(url);if(r.ok){{const t=await r.text();
 if(t!==pre.textContent){{pre.textContent=t;bottom()}}}}}}catch(e){{}}}}
setInterval(tick,2000);
for(const f of document.querySelectorAll('form[action="/send"],form[action="/keys"]')){{
 f.addEventListener('submit',async ev=>{{ev.preventDefault();
  const fd=new FormData(f); if(ev.submitter&&ev.submitter.name)fd.append(ev.submitter.name,ev.submitter.value);
  await fetch(f.action,{{method:'POST',body:new URLSearchParams(fd)}});
  const t=document.getElementById('text'); if(f.id==='sendf')t.value='';
  stick=true; setTimeout(tick,300);
 }})}}
</script>
"""
    return page(addr + " - pi hub", body)


# ---------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "pi-hub"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    # -- helpers
    def authed(self):
        if not (USER and PASS):
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                u, _, p = base64.b64decode(h[6:]).decode().partition(":")
            except Exception:
                u = p = ""
            if hmac.compare_digest(u, USER) and hmac.compare_digest(p, PASS):
                return True
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="pi hub"')
        self.end_headers()
        return False

    def reply(self, code, body, ctype="text/html; charset=utf-8"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def redirect(self, to):
        self.send_response(303)
        self.send_header("Location", to)
        self.end_headers()

    def form(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(min(n, 1_000_000)).decode()
        return {k: v[0] for k, v in parse_qs(raw, keep_blank_values=True).items()}

    def same_origin(self):
        # Blocks other websites from POSTing here from your browser.
        origin = self.headers.get("Origin")
        if not origin:
            return True
        return urlparse(origin).netloc == self.headers.get("Host", "")

    # -- routes
    def do_GET(self):
        if not self.authed():
            return
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/":
            self.reply(200, index_html(q.get("msg", ""), bool(q.get("all"))))
        elif u.path == "/t" and q.get("a"):
            self.reply(200, term_html(q["a"]))
        elif u.path == "/screen" and q.get("a"):
            self.reply(200, screen(q["a"]), "text/plain; charset=utf-8")
        else:
            self.reply(404, page("not found", "<p>not found · <a href='/'>home</a></p>"))

    def do_POST(self):
        if not self.authed():
            return
        if not self.same_origin():
            return self.reply(403, "cross-origin request refused", "text/plain")
        path = urlparse(self.path).path
        f = self.form()
        addr = f.get("a", "")
        back = term_link(addr) if addr else "/"

        if path == "/send" and addr:
            text = f.get("text", "")
            ok, out = hc("send", addr, text) if text else (True, "")
        elif path == "/keys" and addr and f.get("k") in KEYS:
            ok, out = hc("keys", addr, f["k"])
        elif path == "/kill" and addr:
            ok, out = hc("kill", addr)
            back = "/"
        elif path == "/new":
            args = ["run", "--bg", "--no-parent", "--outlive-parent"]
            if f.get("on"):
                args += ["--on", f["on"]]
            if f.get("cwd", "").strip():
                args += ["--cwd", f["cwd"].strip()]
            if f.get("name", "").strip():
                args += ["--name", f["name"].strip()]
            args += ["--json", "--", *AGENT.split()]
            ok, out = hc(*args, timeout=60)
            back = "/"
            if ok:
                try:
                    a = json.loads(out.strip().splitlines()[-1]).get("address")
                    if a and f.get("on") and "/" not in a:
                        a = f"{f['on']}/{a}"
                    if a:
                        back = term_link(a)
                except (ValueError, IndexError, AttributeError):
                    pass
        else:
            return self.reply(400, "bad request", "text/plain")

        if not ok:
            # fetch() callers just see the status; plain form posts land on the error.
            return self.redirect("/?" + urlencode({"msg": out[:500]}))
        self.redirect(back)


def main():
    if not (USER and PASS) and BIND not in ("127.0.0.1", "localhost", "::1"):
        print(f"warning: listening on {BIND} with no password; anyone who can "
              "reach it can run commands. Use a Tailscale IP or set PIHUB_USER/PIHUB_PASS.",
              file=sys.stderr)
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"pi hub on http://{BIND}:{PORT}  (hc: {HC}, agent: {AGENT})", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
