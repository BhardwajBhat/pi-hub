// pi rc relay: passes messages between pi sessions (laptops) and browsers (phone).
// It runs no agent and stores nothing: sessions appear while their pi is connected.
//
//   GET /                 the web page
//   GET /agent?token=...  WebSocket for a pi session (the extension)
//   GET /viewer?token=... WebSocket for a browser
//   POST /pages           publish or update a page   (Authorization: Bearer <token>)
//   GET /pages            list published pages       (Authorization: Bearer <token>)
//   DELETE /pages/<id>    remove a page              (Authorization: Bearer <token>)
//   GET /a/<id>/<path>    a published page: public to anyone with the link, served
//                         sandboxed so it cannot read the token or reach the relay API
//
// One Durable Object ("hub") holds every connection, using the hibernation API so
// an idle hub costs nothing. Connection details live in socket attachments, which
// survive hibernation.
import { DurableObject } from "cloudflare:workers";
import PAGE from "./page.html";

interface Env {
  HUB: DurableObjectNamespace<Hub>;
  PAGES: DurableObjectNamespace<Pages>;
  TOKEN: string;
}

type AgentInfo = { kind: "agent"; id: string; machine: string; cwd: string; name: string; busy: boolean; caps: string[] };
type ViewerInfo = { kind: "viewer"; vid: string; open: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const pages = () => env.PAGES.get(env.PAGES.idFromName("pages"));
    const served = url.pathname.match(/^\/a\/([a-z0-9]{8,64})(\/.*)?$/);
    if (served && req.method === "GET") {
      if (!served[2]) return Response.redirect(url.origin + url.pathname + "/", 301);
      return serveFile(await pages().file(served[1], served[2]));
    }
    const isPages = url.pathname === "/pages" || url.pathname.startsWith("/pages/");
    if (!isPages && url.pathname !== "/agent" && url.pathname !== "/viewer") {
      return new Response("not found", { status: 404 });
    }
    if (!env.TOKEN) return new Response("relay has no TOKEN secret set", { status: 500 });
    const given = url.searchParams.get("token") ?? (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!timingSafeEqual(given, env.TOKEN)) {
      return new Response("bad token", { status: 401 });
    }
    if (isPages) {
      try {
        if (req.method === "POST" && url.pathname === "/pages") {
          if (Number(req.headers.get("content-length") ?? 0) > MAX_PAGE_BYTES * 1.4 + 100_000) throw new Error("page too large");
          const r = await pages().publish(await req.json());
          return Response.json({ ...r, url: `${url.origin}/a/${r.id}/` });
        }
        if (req.method === "GET" && url.pathname === "/pages") {
          return Response.json((await pages().list()).map((p) => ({ ...p, url: `${url.origin}/a/${p.id}/` })));
        }
        const del = url.pathname.match(/^\/pages\/([a-z0-9]{8,64})$/);
        if (req.method === "DELETE" && del) return Response.json({ deleted: await pages().remove(del[1]) });
      } catch (e) {
        return Response.json({ error: String((e as Error).message ?? e) }, { status: 400 });
      }
      return new Response("not found", { status: 404 });
    }
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

// ---- published pages ------------------------------------------------------

const MAX_PAGE_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 300;
const CHUNK = 1024 * 1024; // SQLite rows in Durable Objects are limited to 2 MB

type PageFile = { type: string; data: ArrayBuffer } | null;

function serveFile(f: PageFile): Response {
  if (!f) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  return new Response(f.data, {
    headers: {
      "content-type": f.type,
      // An opaque, sandboxed origin: page scripts run, but cannot read this
      // site's storage (the relay token) or call the relay as the viewer.
      "content-security-policy": "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "access-control-allow-origin": "*", // the sandboxed page fetching its own files
      "cache-control": "no-cache",
    },
  });
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(15));
  return [...b].map((x) => x.toString(36).padStart(2, "0")).join("").slice(0, 24);
}

function cleanPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (!parts.length || parts.some((x) => x === "..")) return null;
  return parts.join("/");
}

export class Pages extends DurableObject<Env> {
  sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT, bytes INTEGER, files INTEGER, created INTEGER, updated INTEGER);
      CREATE TABLE IF NOT EXISTS files (page TEXT, path TEXT, type TEXT, chunk INTEGER, data BLOB, PRIMARY KEY (page, path, chunk));`);
  }

  publish(body: any): { id: string; updated: boolean } {
    const files: { path: string; type: string; bytes: Uint8Array }[] = [];
    let total = 0;
    for (const f of Array.isArray(body?.files) ? body.files : []) {
      const path = cleanPath(String(f?.path ?? ""));
      if (!path || typeof f.data !== "string") throw new Error("bad file entry");
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      total += bytes.length;
      files.push({ path, type: String(f.type || "application/octet-stream"), bytes });
    }
    if (!files.length) throw new Error("no files");
    if (files.length > MAX_FILES) throw new Error(`too many files (max ${MAX_FILES})`);
    if (total > MAX_PAGE_BYTES) throw new Error("page too large (max 20 MB)");
    if (!files.some((f) => f.path === "index.html")) throw new Error("needs an index.html");

    let id = typeof body.id === "string" ? body.id : "";
    const updated = !!id;
    if (updated && !this.sql.exec("SELECT 1 FROM pages WHERE id = ?", id).toArray().length) {
      throw new Error("no page with id " + id);
    }
    if (!id) id = newId();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM files WHERE page = ?", id);
      for (const f of files) {
        for (let i = 0, n = 0; i < Math.max(1, f.bytes.length); i += CHUNK, n++) {
          this.sql.exec("INSERT INTO files VALUES (?, ?, ?, ?, ?)", id, f.path, f.type, n, f.bytes.slice(i, i + CHUNK).buffer);
        }
      }
      const title = String(body.title ?? "").slice(0, 200);
      this.sql.exec(
        `INSERT INTO pages VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, bytes = excluded.bytes, files = excluded.files, updated = excluded.updated`,
        id, title, total, files.length, now, now);
    });
    return { id, updated };
  }

  file(id: string, rawPath: string): PageFile {
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { return null; }
    const cleaned = cleanPath(decoded);
    if (!cleaned && decoded.replace(/\//g, "") !== "") return null; // "..", odd paths
    let path = cleaned ?? "index.html";
    if (rawPath.endsWith("/") && path !== "index.html") path += "/index.html";
    const rows = this.sql.exec<{ type: string; data: ArrayBuffer }>(
      "SELECT type, data FROM files WHERE page = ? AND path = ? ORDER BY chunk", id, path).toArray();
    if (!rows.length) return null;
    const size = rows.reduce((n, r) => n + r.data.byteLength, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const r of rows) { out.set(new Uint8Array(r.data), at); at += r.data.byteLength; }
    return { type: rows[0].type, data: out.buffer };
  }

  list() {
    return this.sql.exec<{ id: string; title: string; bytes: number; files: number; created: number; updated: number }>(
      "SELECT id, title, bytes, files, created, updated FROM pages ORDER BY updated DESC").toArray();
  }

  remove(id: string): boolean {
    const had = this.sql.exec("SELECT 1 FROM pages WHERE id = ?", id).toArray().length > 0;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM files WHERE page = ?", id);
      this.sql.exec("DELETE FROM pages WHERE id = ?", id);
    });
    return had;
  }
}

// ---- helpers ---------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export class Hub extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const kind = new URL(req.url).pathname === "/agent" ? "agent" : "viewer";
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [kind]);
    if (kind === "viewer") {
      server.serializeAttachment({ kind, vid: crypto.randomUUID(), open: "" } satisfies ViewerInfo);
      server.send(JSON.stringify({ type: "sessions", sessions: this.sessions() }));
    } else {
      server.serializeAttachment(null); // filled in by the agent's hello
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  sessions(gone?: WebSocket): Omit<AgentInfo, "kind">[] {
    const out = [];
    for (const ws of this.ctx.getWebSockets("agent")) {
      if (ws === gone) continue;
      const a = ws.deserializeAttachment() as AgentInfo | null;
      if (a) out.push({ id: a.id, machine: a.machine, cwd: a.cwd, name: a.name, busy: a.busy, caps: a.caps ?? [] });
    }
    return out;
  }

  agent(id: string): WebSocket | undefined {
    return this.ctx.getWebSockets("agent").find((ws) => (ws.deserializeAttachment() as AgentInfo | null)?.id === id);
  }

  toViewers(msg: unknown, filter: (v: ViewerInfo) => boolean = () => true) {
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets("viewer")) {
      if (filter(ws.deserializeAttachment() as ViewerInfo)) safeSend(ws, text);
    }
  }

  listChanged(gone?: WebSocket) {
    this.toViewers({ type: "sessions", sessions: this.sessions(gone) });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let m: any;
    try {
      m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const me = ws.deserializeAttachment() as AgentInfo | ViewerInfo | null;

    if (me === null || me.kind === "agent") {
      // ---- from a pi session
      if (m.type === "hello") {
        const info: AgentInfo = {
          kind: "agent", id: String(m.id), machine: String(m.machine ?? "?"),
          cwd: String(m.cwd ?? ""), name: String(m.name ?? ""), busy: !!m.busy,
          caps: Array.isArray(m.caps) ? m.caps.map(String).slice(0, 20) : [],
        };
        // A reconnect replaces the old socket for the same session.
        this.agent(info.id)?.close(4000, "replaced");
        ws.serializeAttachment(info);
        this.listChanged();
        // Viewers already looking at this session get fresh history.
        for (const v of this.ctx.getWebSockets("viewer")) {
          const vi = v.deserializeAttachment() as ViewerInfo;
          if (vi.open === info.id) safeSend(ws, JSON.stringify({ type: "snapshot_request", to: vi.vid }));
        }
        return;
      }
      if (!me) return;
      if (m.type === "snapshot") {
        this.toViewers({ type: "snapshot", id: me.id, data: m.data }, (v) => v.vid === m.to);
      } else if (m.type === "event") {
        const ev = m.event ?? {};
        if (ev.type === "busy" || ev.type === "name") {
          if (ev.type === "busy") me.busy = !!ev.busy;
          if (ev.type === "name") me.name = String(ev.name ?? "");
          ws.serializeAttachment(me);
          this.listChanged();
        }
        this.toViewers({ type: "event", id: me.id, event: ev }, (v) => v.open === me.id);
      }
      return;
    }

    // ---- from a browser
    if (m.type === "open") {
      me.open = String(m.id ?? "");
      ws.serializeAttachment(me);
      const a = this.agent(me.open);
      if (a) safeSend(a, JSON.stringify({ type: "snapshot_request", to: me.vid }));
      else safeSend(ws, JSON.stringify({ type: "gone", id: me.open }));
    } else if (m.type === "prompt" || m.type === "abort") {
      const a = this.agent(String(m.id ?? ""));
      if (!a) return safeSend(ws, JSON.stringify({ type: "gone", id: m.id }));
      if (m.type === "abort") return safeSend(a, JSON.stringify({ type: "abort" }));
      const images = (Array.isArray(m.images) ? m.images : []).slice(0, 8)
        .filter((i: any) => typeof i?.data === "string" && typeof i?.mimeType === "string")
        .map((i: any) => ({ data: i.data, mimeType: i.mimeType }));
      safeSend(a, JSON.stringify({ type: "prompt", text: String(m.text ?? ""), images }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    const me = ws.deserializeAttachment() as AgentInfo | ViewerInfo | null;
    if (me?.kind === "agent") {
      // Only announce if this was the session's live socket (not one replaced by a reconnect).
      if (!this.ctx.getWebSockets("agent").some((s) => s !== ws && (s.deserializeAttachment() as AgentInfo | null)?.id === me.id)) {
        this.toViewers({ type: "gone", id: me.id }, (v) => v.open === me.id);
      }
      this.listChanged(ws);
    }
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
}

function safeSend(ws: WebSocket, text: string) {
  try {
    ws.send(text);
  } catch {
    // socket already closing
  }
}
