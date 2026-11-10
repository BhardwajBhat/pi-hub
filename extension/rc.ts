// pi rc: mirror this pi session to your relay, so you can follow and continue it
// from a phone or any browser. It is the same session: messages sent from the web
// arrive here as if typed, and everything here shows up there.
//
// Setup once per machine:   /rc setup https://pi-rc.<you>.workers.dev <token>
// Then every pi session connects on its own. /rc shows status and the web link,
// /rc off and /rc on toggle it for the current session.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";

type Config = { url: string; token: string };

const CONFIG_FILE = join(getAgentDir(), "pi-rc.json");

function loadConfig(): Config | null {
  const url = process.env.PI_RC_URL, token = process.env.PI_RC_TOKEN;
  if (url && token) return { url, token };
  try {
    const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    if (c.url && c.token) return { url: String(c.url), token: String(c.token) };
  } catch {}
  return null;
}

function saveConfig(c: Config) {
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

const tilde = (path: string) => (path.startsWith(homedir()) ? "~" + path.slice(homedir().length) : path);
const base = (url: string) => url.replace(/\/+$/, "");
const wsUrl = (c: Config) =>
  base(c.url).replace(/^http/, "ws") + "/agent?token=" + encodeURIComponent(c.token);
const webLink = (c: Config) => base(c.url) + "/#token=" + encodeURIComponent(c.token);

// Images are large and the web view does not show them; send a placeholder.
function slim<T>(message: T): T {
  const m: any = message;
  if (!m || !Array.isArray(m.content)) return message;
  return {
    ...m,
    content: m.content.map((b: any) =>
      b?.type === "image" ? { type: "text", text: "[image]" } : b,
    ),
  };
}

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | null = null;
  let ws: WebSocket | null = null;
  let enabled = true;
  let busy = false;
  let partial: unknown = null;
  let retryMs = 1000;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let lastUpdate = 0;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;

  const status = (text: string | undefined) => ctx?.hasUI && ctx.ui.setStatus("rc", text);

  function send(msg: unknown) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
  const event = (e: unknown) => send({ type: "event", event: e });

  function history() {
    if (!ctx) return [];
    return ctx.sessionManager
      .getBranch()
      .filter((e: any) => e.type === "message")
      .map((e: any) => slim(e.message));
  }

  function connect() {
    clearTimeout(retryTimer);
    const config = loadConfig();
    if (!enabled || !ctx || !config) return;
    if (typeof WebSocket === "undefined") {
      status("rc: needs Node 22+");
      return;
    }
    const sock = new WebSocket(wsUrl(config));
    ws = sock;
    sock.onopen = () => {
      retryMs = 1000;
      status("rc ●");
      send({
        type: "hello",
        id: ctx!.sessionManager.getSessionId(),
        machine: hostname(),
        cwd: tilde(ctx!.cwd),
        name: pi.getSessionName() ?? basename(ctx!.cwd),
        busy,
        // What this version of the extension can do, so the page can adapt.
        caps: ["images"],
      });
      clearInterval(pingTimer);
      pingTimer = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send("ping"), 30_000);
    };
    sock.onmessage = (e) => {
      if (e.data === "pong") return;
      let m: any;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (m.type === "snapshot_request") {
        send({ type: "snapshot", to: m.to, data: { messages: history(), partial, busy } });
      } else if (m.type === "prompt") {
        const text = typeof m.text === "string" ? m.text.trim() : "";
        const images = (Array.isArray(m.images) ? m.images : [])
          .filter((i: any) => typeof i?.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(i?.mimeType))
          .map((i: any) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType }));
        if (!text && !images.length) return;
        const content = images.length ? [{ type: "text" as const, text }, ...images] : text;
        // While pi is working, queue it like a follow-up typed in the terminal.
        if (ctx && !ctx.isIdle()) pi.sendUserMessage(content, { deliverAs: "followUp" });
        else pi.sendUserMessage(content);
      } else if (m.type === "abort") {
        ctx?.abort();
      }
    };
    sock.onclose = (e) => {
      clearInterval(pingTimer);
      if (ws !== sock) return; // replaced or turned off on purpose
      ws = null;
      if (e.code === 1008 || e.code === 4001) {
        status("rc: bad token");
        return;
      }
      status("rc ○");
      retryTimer = setTimeout(connect, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
    sock.onerror = () => {}; // onclose follows and handles retry
  }

  function disconnect() {
    clearTimeout(retryTimer);
    clearInterval(pingTimer);
    clearTimeout(updateTimer);
    const sock = ws;
    ws = null;
    sock?.close();
  }

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    busy = false;
    partial = null;
    if (!loadConfig()) {
      status("rc: run /rc setup");
      return;
    }
    connect();
  });
  pi.on("session_shutdown", async () => {
    disconnect();
    ctx = null;
  });
  pi.on("session_info_changed", async (e: any) => event({ type: "name", name: e.name ?? "" }));

  pi.on("agent_start", async () => {
    busy = true;
    event({ type: "busy", busy: true });
  });
  pi.on("agent_settled", async () => {
    busy = false;
    partial = null;
    event({ type: "busy", busy: false });
  });

  pi.on("message_start", async (e: any) => {
    if (e.message?.role === "assistant") {
      partial = slim(e.message);
      event({ type: "message_start", message: partial });
    }
  });
  // Streaming updates are throttled to a few per second; the final message is always sent.
  pi.on("message_update", async (e: any) => {
    partial = slim(e.message);
    const flush = () => {
      lastUpdate = Date.now();
      if (partial) event({ type: "message_update", message: partial });
    };
    clearTimeout(updateTimer);
    const wait = 250 - (Date.now() - lastUpdate);
    if (wait <= 0) flush();
    else updateTimer = setTimeout(flush, wait);
  });
  pi.on("message_end", async (e: any) => {
    clearTimeout(updateTimer);
    if (e.message?.role === "assistant") partial = null;
    event({ type: "message_end", message: slim(e.message) });
  });
  pi.on("tool_execution_start", async (e: any) => event({ type: "activity", text: "running " + e.toolName + "…" }));
  pi.on("tool_execution_end", async () => event({ type: "activity", text: "" }));

  pi.registerCommand("rc", {
    description: "Remote control: /rc [setup <url> <token> | on | off]",
    handler: async (args, c) => {
      ctx = c;
      const [cmd, url, token] = (args ?? "").trim().split(/\s+/);
      if (cmd === "setup") {
        if (!url || !token) {
          c.ui.notify("Usage: /rc setup <relay url> <token>", "error");
          return;
        }
        saveConfig({ url, token });
        enabled = true;
        disconnect();
        connect();
        c.ui.notify(`Saved to ${CONFIG_FILE}. Open on your phone:\n${webLink({ url, token })}`, "info");
      } else if (cmd === "off") {
        enabled = false;
        disconnect();
        status("rc off");
      } else if (cmd === "on") {
        enabled = true;
        connect();
      } else {
        const config = loadConfig();
        if (!config) {
          c.ui.notify("Not set up. Run: /rc setup <relay url> <token>", "warning");
          return;
        }
        const state = !enabled ? "off" : ws?.readyState === WebSocket.OPEN ? "connected" : "connecting…";
        c.ui.notify(`rc ${state}. Web: ${webLink(config)}`, "info");
      }
    },
  });
}

