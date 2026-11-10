// pi rc: mirror this pi session to your relay, so you can follow and continue it
// from a phone or any browser. It is the same session: messages sent from the web
// arrive here as if typed, and everything here shows up there.
//
// Setup once per machine:   /rc setup https://pi-rc.<you>.workers.dev <token>
// Then every pi session connects on its own. /rc shows status and the web link,
// /rc off and /rc on toggle it for the current session.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { homedir, hostname } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

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

// ---- publishing pages -----------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".wasm": "application/wasm", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".pdf": "application/pdf",
};
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv"]);
const MAX_FILES = 300, MAX_BYTES = 20 * 1024 * 1024;

function collect(root: string): { path: string; type: string; data: string }[] {
  const st = statSync(root);
  if (st.isFile()) {
    if (!/\.html?$/i.test(root)) throw new Error("A single file must be .html. For other files, publish the folder that has an index.html.");
    return [{ path: "index.html", type: MIME[".html"], data: readFileSync(root).toString("base64") }];
  }
  const out: { path: string; type: string; data: string }[] = [];
  let bytes = 0;
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
      const full = join(dir, name), s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (s.isFile()) {
        bytes += s.size;
        if (out.length >= MAX_FILES) throw new Error(`Too many files (max ${MAX_FILES}). Publish a smaller folder, e.g. the build output.`);
        if (bytes > MAX_BYTES) throw new Error("Folder is over 20 MB. Publish a smaller folder, e.g. the build output.");
        const type = MIME[extname(name).toLowerCase()] ?? "application/octet-stream";
        out.push({ path: relative(root, full).split("\\").join("/"), type, data: readFileSync(full).toString("base64") });
      }
    }
  };
  walk(root);
  if (!out.some((f) => f.path === "index.html")) throw new Error("The folder needs an index.html at its top level.");
  return out;
}

async function relayFetch(c: Config, path: string, init: RequestInit = {}) {
  const res = await fetch(base(c.url) + path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: "Bearer " + c.token, "content-type": "application/json" },
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `relay answered ${res.status}`);
  return body;
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

  // The page id published from each path, kept in the session so republishing
  // the same file or folder updates the same link.
  function knownId(path: string): string | undefined {
    let id: string | undefined;
    for (const e of ctx?.sessionManager.getEntries() ?? []) {
      const d: any = (e as any).type === "custom" && (e as any).customType === "pi-rc-page" ? (e as any).data : null;
      if (d?.path === path) id = d.id;
    }
    return id;
  }

  pi.registerTool({
    name: "publish_page",
    label: "Publish page",
    description:
      "Publish an HTML page (a single .html file, or a folder with index.html plus its CSS/JS/images) to the user's " +
      "pi rc relay and get a link they can open on their phone or share. Publishing the same path again updates " +
      "the same link. Pages are public to anyone with the link and run sandboxed (no localStorage or cookies).",
    promptSnippet: "Publish an HTML file or folder as a shareable web page (like an artifact)",
    promptGuidelines: [
      "Before making a page to publish, load the publish-page skill for how to build and publish it.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "An .html file, or a folder containing index.html (relative to the working directory)" }),
      title: Type.Optional(Type.String({ description: "Short title for the page list" })),
      new_link: Type.Optional(Type.Boolean({ description: "Publish under a new link instead of updating this path's earlier one" })),
    }),
    async execute(_id, params, _signal, _onUpdate, c) {
      const config = needConfig();
      const full = resolve(c.cwd, params.path.replace(/^~(?=\/|$)/, homedir()));
      const files = collect(full);
      const id = params.new_link ? undefined : knownId(full);
      const r = await relayFetch(config, "/pages", {
        method: "POST",
        body: JSON.stringify({ id, title: params.title ?? basename(full), files }),
      });
      if (!id) pi.appendEntry("pi-rc-page", { path: full, id: r.id });
      return {
        content: [{ type: "text", text: `${r.updated ? "Updated" : "Published"}: ${r.url}` }],
        details: { url: r.url, id: r.id, files: files.length },
      };
    },
  });

  const needConfig = () => {
    const config = loadConfig();
    if (!config) throw new Error("pi rc is not set up on this machine. The user needs to run: /rc setup <relay url> <token>");
    return config;
  };
  const ago = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
  };

  pi.registerTool({
    name: "list_pages",
    label: "List pages",
    description: "List the pages published to the user's pi rc relay (from every machine and session): id, title, size, last update and link.",
    promptSnippet: "List published pages and their links",
    parameters: Type.Object({}),
    async execute() {
      const list: any[] = await relayFetch(needConfig(), "/pages");
      const text = list.length
        ? list.map((p) => `- ${p.title || "(untitled)"} · ${Math.ceil(p.bytes / 1024)} KB · updated ${ago(p.updated)}\n  id: ${p.id}\n  ${p.url}`).join("\n")
        : "No pages are published.";
      return { content: [{ type: "text", text }], details: { pages: list } };
    },
  });

  pi.registerTool({
    name: "delete_page",
    label: "Delete page",
    description: "Delete a published page by its id (from list_pages). Its link stops working. Only when the user asks.",
    promptSnippet: "Delete a published page by id",
    parameters: Type.Object({ id: Type.String({ description: "Page id from list_pages" }) }),
    async execute(_id, params) {
      const r = await relayFetch(needConfig(), "/pages/" + encodeURIComponent(params.id), { method: "DELETE" });
      return { content: [{ type: "text", text: r.deleted ? `Deleted page ${params.id}.` : `No page with id ${params.id}.` }], details: r };
    },
  });

  pi.registerCommand("rc", {
    description: "Remote control: /rc [setup <url> <token> | on | off | pages | unpublish <id>]",
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
      } else if (cmd === "pages" || cmd === "unpublish") {
        const config = loadConfig();
        if (!config) return c.ui.notify("Not set up. Run: /rc setup <relay url> <token>", "warning");
        try {
          if (cmd === "unpublish") {
            if (!url) return c.ui.notify("Usage: /rc unpublish <page id>", "error");
            const r = await relayFetch(config, "/pages/" + encodeURIComponent(url), { method: "DELETE" });
            return c.ui.notify(r.deleted ? `Deleted ${url}` : `No page ${url}`, "info");
          }
          const list: any[] = await relayFetch(config, "/pages");
          c.ui.notify(list.length
            ? list.map((p) => `${p.id}  ${p.title}  (${Math.ceil(p.bytes / 1024)} KB)\n  ${p.url}`).join("\n")
            : "No published pages.", "info");
        } catch (e) {
          c.ui.notify("rc: " + (e as Error).message, "error");
        }
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

