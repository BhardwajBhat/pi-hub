"""Structured Pi conversations. No terminal scraping; stdlib-only RPC client."""
import copy
import json
import os
from pathlib import Path
import shlex
import subprocess
import threading
import uuid


class Conversation:
    def __init__(self, store, record):
        self.store = store
        self.record = record
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.process = None
        self.busy = False
        self.error = ""
        self.partial = None
        self.dialogs = {}
        self.pending = {}
        self.model = ""
        self.thinking = ""
        self.activity = ""
        self.stderr = ""

    def snapshot(self, messages=True):
        with self.lock:
            out = {k: self.record[k] for k in ("id", "name", "cwd")}
            out["machine"] = self.record.get("machine", "")
            out.update(busy=self.busy, error=self.error, model=self.model,
                       thinking=self.thinking, activity=self.activity,
                       running=self.process is not None and self.process.poll() is None)
            if messages:
                out.update(messages=copy.deepcopy(self.record["messages"]),
                           partial=copy.deepcopy(self.partial),
                           dialogs=copy.deepcopy(list(self.dialogs.values())))
            return out

    def start(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return
            argv, cwd = self.store.command_for(self.record)
            self.error = self.stderr = ""
            # Binary pipes split only on LF, not Unicode line separators.
            self.process = subprocess.Popen(argv, cwd=cwd,
                                            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                            stderr=subprocess.PIPE)
            p = self.process
            threading.Thread(target=self._read, args=(p,), daemon=True).start()
            threading.Thread(target=self._stderr, args=(p,), daemon=True).start()
        self.command("get_state")
        self.command("get_messages")

    def command(self, kind, **fields):
        with self.lock:
            p = self.process
            if p is None or p.poll() is not None:
                raise ValueError("Conversation is not running. Send a message to resume it.")
            ident = uuid.uuid4().hex
            event = threading.Event()
            result = {}
            self.pending[ident] = (event, result)
        try:
            self._write(p, dict(type=kind, id=ident, **fields))
            if not event.wait(15):
                raise ValueError("Pi did not acknowledge the command within 15 seconds")
            if not result.get("success"):
                raise ValueError(result.get("error", "Pi rejected the command"))
            return result.get("data", {})
        finally:
            with self.lock:
                self.pending.pop(ident, None)

    def _write(self, process, record):
        try:
            with self.write_lock:
                process.stdin.write(json.dumps(record, ensure_ascii=False).encode() + b"\n")
                process.stdin.flush()
        except (OSError, ValueError) as exc:
            raise ValueError("Pi disconnected: " + str(exc)) from exc

    def prompt(self, text):
        self.start()
        with self.lock:
            if self.busy:
                raise ValueError("Pi is working. Stop it or wait before sending another message.")
            self.busy = True
            self.error = ""
        try:
            data = self.command("prompt", message=text)
            if data.get("disposition") == "handled":
                with self.lock:
                    self.busy = False
            return data
        except Exception:
            with self.lock:
                self.busy = False
            raise

    def answer(self, ident, value, cancelled):
        with self.lock:
            request = self.dialogs.get(ident)
            if request is None:
                raise ValueError("This question has already been answered")
            result = {"type": "extension_ui_response", "id": ident}
            if cancelled:
                result["cancelled"] = True
            elif request["method"] == "confirm":
                result["confirmed"] = value == "yes"
            else:
                if request["method"] == "select" and value not in request.get("options", []):
                    raise ValueError("Invalid selection")
                result["value"] = value
            self._write(self.process, result)
            self.dialogs.pop(ident, None)

    def _stderr(self, p):
        while True:
            chunk = p.stderr.read1(4096)
            if not chunk:
                break
            with self.lock:
                self.stderr = (self.stderr + chunk.decode("utf-8", "replace"))[-8000:]
        p.stderr.close()

    def _read(self, p):
        try:
            for line in p.stdout:
                try:
                    record = json.loads(line)
                    if not isinstance(record, dict):
                        continue
                    self._event(record)
                except (ValueError, TypeError, KeyError):
                    with self.lock:
                        self.error = "Received an invalid RPC record from Pi"
        finally:
            p.stdout.close()
            code = p.wait()
            with self.lock:
                self.busy = False
                self.partial = None
                self.activity = ""
                self.dialogs.clear()
                if code:
                    self.error = self.stderr.strip() or f"Pi exited with code {code}"
                for event, result in self.pending.values():
                    result.update(success=False, error=self.error or "Pi disconnected")
                    event.set()

    def _event(self, e):
        save = False
        with self.lock:
            kind = e.get("type")
            if kind == "response":
                command = e.get("command")
                data = e.get("data") or {}
                if e.get("success"):
                    if command == "get_state":
                        model = data.get("model") or {}
                        self.model = "/".join(filter(None, [model.get("provider"), model.get("id")]))
                        self.thinking = data.get("thinkingLevel", "")
                        self.busy = data.get("isStreaming", False)
                    elif command == "get_messages":
                        self.record["messages"] = data.get("messages", [])
                        save = True
                else:
                    self.error = e.get("error", "Pi command failed")
                pending = self.pending.get(e.get("id"))
                if pending:
                    pending[1].update(e)
                    pending[0].set()
            elif kind == "agent_start":
                self.busy = True
            elif kind == "agent_settled":
                self.busy = False
                self.activity = ""
                self.partial = None
            elif kind == "message_start" and e["message"].get("role") == "assistant":
                self.partial = copy.deepcopy(e["message"])
            elif kind == "message_update" and self.partial is not None:
                update = e.get("assistantMessageEvent", {})
                typ = update.get("type", "")
                if typ in ("text_delta", "thinking_delta", "text_end", "thinking_end"):
                    index = update.get("contentIndex", 0)
                    if not isinstance(index, int) or not 0 <= index < 1024:
                        return
                    content = self.partial.setdefault("content", [])
                    while len(content) <= index:
                        content.append({})
                    block = content[index]
                    field = "thinking" if typ.startswith("thinking") else "text"
                    block["type"] = field
                    block[field] = (block.get(field, "") + update.get("delta", "")
                                    if typ.endswith("delta") else update.get("content", ""))
            elif kind == "message_end":
                msg = e["message"]
                self.record["messages"].append(msg)
                if msg.get("role") == "assistant":
                    self.partial = None
                    if msg.get("errorMessage"):
                        self.error = msg["errorMessage"]
                save = True
            elif kind == "tool_execution_start":
                self.activity = "Running " + e.get("toolName", "tool") + "…"
            elif kind == "tool_execution_end":
                self.activity = ""
            elif kind == "auto_retry_start":
                self.activity = "Retrying: " + e.get("errorMessage", "")
            elif kind == "compaction_start":
                self.activity = "Compacting conversation…"
            elif kind == "session_info_changed" and e.get("name"):
                self.record["name"] = e["name"]
                save = True
            elif kind == "extension_ui_request":
                method = e.get("method")
                if method in ("select", "confirm", "input", "editor"):
                    self.dialogs[e["id"]] = e
                elif method == "notify":
                    self.activity = e.get("message", "")
        if save:
            self.store.save()

    def close(self):
        with self.lock:
            p = self.process
        if p is None or p.poll() is not None:
            return
        # EOF asks Pi to shut down cleanly; only kill our own child if it hangs.
        with self.write_lock:
            p.stdin.close()
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            p.terminate()
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()


def remote_path(path):
    """Quote a path for a POSIX shell, keeping a leading ~ as $HOME."""
    if path in ("", "~"):
        return '"$HOME"'
    if path.startswith("~/"):
        return '"$HOME"/' + shlex.quote(path[2:])
    return shlex.quote(path)


class ChatStore:
    """Conversations on this machine or, over ssh, on any machine in PIHUB_MACHINES."""

    def __init__(self, agent, machines=None, ssh=None, remote_agent=None):
        self.agent = agent
        if machines is None:
            machines = os.environ.get("PIHUB_MACHINES", "")
        if isinstance(machines, str):
            machines = [m.strip() for m in machines.replace(",", " ").split()]
        # A machine name is passed to ssh, so refuse anything that could be an option.
        self.machines = [m for m in machines if m and not m.startswith("-")]
        self.ssh = ssh or os.environ.get("PIHUB_SSH", "ssh")
        self.remote_agent = remote_agent or os.environ.get("PIHUB_REMOTE_AGENT", "pi")
        self.path = Path(os.environ.get("PIHUB_DATA_DIR", "~/.local/share/pi-hub")).expanduser()
        self.lock = threading.RLock()
        self.save_lock = threading.Lock()
        self.conversations = {}
        # Load lazily: importing the module never writes user data or starts Pi.
        self.loaded = False

    def load(self):
        with self.lock:
            if self.loaded:
                return
            self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
            (self.path / "sessions").mkdir(exist_ok=True, mode=0o700)
            file = self.path / "conversations.json"
            records = json.loads(file.read_text()) if file.exists() else []
            for r in records:
                self.conversations[r["id"]] = Conversation(self, r)
            self.loaded = True

    def save(self):
        with self.save_lock:
            with self.lock:
                items = list(self.conversations.values())
            records = []
            for c in items:
                with c.lock:
                    records.append(copy.deepcopy(c.record))
            tmp = self.path / "conversations.tmp"
            tmp.write_text(json.dumps(records, ensure_ascii=False))
            tmp.replace(self.path / "conversations.json")

    def command_for(self, record):
        """argv and local cwd that start Pi in RPC mode for this conversation."""
        machine = record.get("machine", "")
        if not machine:
            argv = shlex.split(self.agent)
            if not argv:
                raise ValueError("PIHUB_AGENT must name a Pi executable")
            return argv + ["--mode", "rpc", "--session-dir", str(self.path / "sessions"),
                           "--session-id", record["id"]], record["cwd"]
        if machine not in self.machines:
            raise ValueError(f"Machine {machine!r} is not in PIHUB_MACHINES")
        agent = shlex.split(self.remote_agent)
        if not agent:
            raise ValueError("PIHUB_REMOTE_AGENT must name a Pi executable")
        sessions = '"$HOME"/.local/share/pi-hub/sessions'
        script = (f"mkdir -p {sessions} && cd {remote_path(record['cwd'])} && exec "
                  + " ".join(shlex.quote(a) for a in agent)
                  + f" --mode rpc --session-dir {sessions} --session-id "
                  + shlex.quote(record["id"]))
        # A login shell, so PATH from ~/.profile (where pi usually lives) is set.
        remote = 'exec "${SHELL:-sh}" -lc ' + shlex.quote(script)
        return shlex.split(self.ssh) + [
            "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=4", machine, remote], None

    def create(self, name, cwd, machine=""):
        self.load()
        machine = (machine or "").strip()
        if machine:
            if machine not in self.machines:
                raise ValueError(f"Unknown machine: {machine}")
            # Checked when Pi starts there; a bad directory shows up as the error.
            cwd = (cwd or "").strip() or "~"
        else:
            cwd = str(Path(cwd or "~").expanduser().resolve())
            if not Path(cwd).is_dir():
                raise ValueError("Directory does not exist: " + cwd)
        ident = uuid.uuid4().hex
        with self.lock:
            c = Conversation(self, dict(id=ident, name=name.strip() or "New conversation",
                                        cwd=cwd, machine=machine, messages=[]))
            self.conversations[ident] = c
        self.save()
        return c

    def get(self, ident):
        self.load()
        with self.lock:
            if ident not in self.conversations:
                raise ValueError("Conversation not found")
            return self.conversations[ident]

    def listing(self):
        self.load()
        with self.lock:
            items = list(self.conversations.values())
        return [c.snapshot(False) for c in items]

    def shutdown(self):
        with self.lock:
            items = list(self.conversations.values())
        for c in items:
            c.close()


def get_route(handler, store, path, query):
    if path == "/":
        handler.reply(200, Path(__file__).with_name("chat.html").read_text())
    elif path == "/chat/machines":
        handler.reply(200, json.dumps(store.machines), "application/json")
    elif path == "/chat/list":
        handler.reply(200, json.dumps(store.listing()), "application/json")
    elif path == "/chat/state":
        try:
            body = store.get(query.get("id", "")).snapshot()
            handler.reply(200, json.dumps(body), "application/json")
        except ValueError as exc:
            handler.reply(404, json.dumps({"error": str(exc)}), "application/json")
    else:
        return False
    return True


def post_route(handler, store, path, form):
    if not path.startswith("/chat/"):
        return False
    try:
        if path == "/chat/new":
            c = store.create(form.get("name", ""), form.get("cwd", ""), form.get("machine", ""))
        else:
            c = store.get(form.get("id", ""))
            if path == "/chat/send":
                text = form.get("text", "").strip()
                if not text:
                    raise ValueError("Write a message first")
                c.prompt(text)
            elif path == "/chat/stop":
                c.command("abort")
            elif path == "/chat/answer":
                c.answer(form.get("request", ""), form.get("value", ""), form.get("cancel") == "1")
            else:
                raise ValueError("Unknown chat action")
        handler.reply(200, json.dumps({"id": c.record["id"]}), "application/json")
    except (ValueError, OSError) as exc:
        handler.reply(400, json.dumps({"error": str(exc)}), "application/json")
    return True
