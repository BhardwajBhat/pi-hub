// pi rc relay: passes messages between pi sessions (laptops) and browsers (phone).
// It runs no agent and stores nothing: sessions appear while their pi is connected.
//
//   GET /                 the web page
//   GET /agent?token=...  WebSocket for a pi session (the extension)
//   GET /viewer?token=... WebSocket for a browser
//
// One Durable Object ("hub") holds every connection, using the hibernation API so
// an idle hub costs nothing. Connection details live in socket attachments, which
// survive hibernation.
import { DurableObject } from "cloudflare:workers";
import PAGE from "./page.html";

interface Env {
  HUB: DurableObjectNamespace<Hub>;
  TOKEN: string;
}

type AgentInfo = { kind: "agent"; id: string; machine: string; cwd: string; name: string; busy: boolean };
type ViewerInfo = { kind: "viewer"; vid: string; open: string };

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname !== "/agent" && url.pathname !== "/viewer") {
      return new Response("not found", { status: 404 });
    }
    if (!env.TOKEN) return new Response("relay has no TOKEN secret set", { status: 500 });
    if (!timingSafeEqual(url.searchParams.get("token") ?? "", env.TOKEN)) {
      return new Response("bad token", { status: 401 });
    }
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("expected a WebSocket", { status: 426 });
    }
    return env.HUB.get(env.HUB.idFromName("hub")).fetch(req);
  },
};

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
      if (a) out.push({ id: a.id, machine: a.machine, cwd: a.cwd, name: a.name, busy: a.busy });
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
      safeSend(a, JSON.stringify(m.type === "prompt" ? { type: "prompt", text: String(m.text ?? "") } : { type: "abort" }));
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
