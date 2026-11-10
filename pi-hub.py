#!/usr/bin/env python3
"""pi-hub: one plain-HTML chat UI for Pi on all your machines.

Each conversation runs `pi --mode rpc` either on this machine or, over ssh, on
a machine listed in PIHUB_MACHINES (see chat.py). Python 3.8+ stdlib only.

    python3 pi-hub.py                    # listens on 127.0.0.1:8377

Settings (environment variables):
    PIHUB_BIND          address to listen on            (default 127.0.0.1)
    PIHUB_PORT          port                            (default 8377)
    PIHUB_AGENT         Pi command on this machine      (default: pi)
    PIHUB_MACHINES      other machines, ssh host names  (e.g. "laptop-a laptop-b")
    PIHUB_REMOTE_AGENT  Pi command on those machines    (default: pi)
    PIHUB_SSH           ssh command                     (default: ssh)
    PIHUB_DATA_DIR      chat storage                    (default ~/.local/share/pi-hub)
    PIHUB_USER / PIHUB_PASS   if both set, HTTP basic auth is required
"""
import base64
import hmac
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from chat import ChatStore, get_route as chat_get, post_route as chat_post

BIND = os.environ.get("PIHUB_BIND", "127.0.0.1")
PORT = int(os.environ.get("PIHUB_PORT", "8377"))
AGENT = os.environ.get("PIHUB_AGENT", "pi")
USER = os.environ.get("PIHUB_USER", "")
PASS = os.environ.get("PIHUB_PASS", "")

CHATS = ChatStore(AGENT)


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-hub"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

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
        try:
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browser navigated away while a response was in flight.

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

    def do_GET(self):
        if not self.authed():
            return
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if not chat_get(self, CHATS, u.path, q):
            self.reply(404, "not found", "text/plain")

    def do_POST(self):
        if not self.authed():
            return
        if not self.same_origin():
            return self.reply(403, "cross-origin request refused", "text/plain")
        try:
            f = self.form()
        except (ValueError, UnicodeError):
            return self.reply(400, "invalid form", "text/plain")
        if not chat_post(self, CHATS, urlparse(self.path).path, f):
            self.reply(404, "not found", "text/plain")


def main():
    if not (USER and PASS) and BIND not in ("127.0.0.1", "localhost", "::1"):
        print(f"warning: listening on {BIND} with no password; anyone who can "
              "reach it can run commands. Use a Tailscale IP or set PIHUB_USER/PIHUB_PASS.",
              file=sys.stderr)
    srv = ThreadingHTTPServer((BIND, PORT), Handler)
    print(f"pi hub on http://{BIND}:{PORT}  (machines: this one"
          + "".join(", " + m for m in CHATS.machines) + ")", file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
        CHATS.shutdown()


if __name__ == "__main__":
    main()
