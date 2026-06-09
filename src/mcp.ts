import { Browser } from "@capacitor/browser";
import { App } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { Mcps } from "./db";
import type {
  McpServerConfig,
  McpTool,
  OAuthState,
} from "./types";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "mcp-chat", version: "0.1.0" };

function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

// In dev (localhost browser), route MCP calls through Vite proxy so the
// server's missing CORS headers don't block us. Production builds (APK and
// PWA) NEVER use the proxy — vite strips `import.meta.env.DEV` to `false`.
function effectiveUrl(url: string): string {
  if (!import.meta.env.DEV) return url;
  if (isNative()) return url;
  if (
    typeof location !== "undefined" &&
    (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  )
    return `/mcp-proxy/${url}`;
  return url;
}

function redirectUri(): string {
  return isNative()
    ? "mcpchat://oauth-callback"
    : `${location.origin}/oauth-callback`;
}

interface Session {
  sessionId?: string;
  rpcId: number;
  tools: McpTool[];
}

const sessions = new Map<string, Session>();

function nextId(s: Session) {
  s.rpcId += 1;
  return s.rpcId;
}

async function rpc<T>(
  cfg: McpServerConfig,
  s: Session,
  method: string,
  params?: unknown,
  notify = false,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": PROTOCOL_VERSION,
  };
  if (s.sessionId) headers["Mcp-Session-Id"] = s.sessionId;
  const auth = authHeader(cfg);
  if (auth) headers.Authorization = auth;

  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    method,
    ...(params ? { params } : {}),
  };
  if (!notify) body.id = nextId(s);

  const res = await fetch(effectiveUrl(cfg.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });

  if (res.status === 401 && cfg.auth === "oauth") {
    await runOAuth(cfg);
    return rpc<T>(cfg, s, method, params, notify);
  }
  if (!res.ok) throw new Error(`MCP ${res.status}: ${await res.text()}`);

  const sid = res.headers.get("Mcp-Session-Id");
  if (sid) s.sessionId = sid;
  if (notify) return undefined as T;

  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("text/event-stream")) {
    return readSseResponse<T>(res, body.id as number, signal);
  }
  const json = await res.json();
  if (json.error) throw new Error(`MCP error: ${json.error.message}`);
  return json.result as T;
}

async function readSseResponse<T>(
  res: Response,
  wantId: number,
  signal?: AbortSignal,
): Promise<T> {
  const reader = res.body!.getReader();
  const abort = () => void reader.cancel("aborted");
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split("\n\n");
      buf = events.pop() ?? "";
      for (const evt of events) {
        const dataLines = evt
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart());
        if (!dataLines.length) continue;
        try {
          const json = JSON.parse(dataLines.join("\n"));
          if (json.id === wantId) {
            if (json.error) throw new Error(`MCP error: ${json.error.message}`);
            return json.result as T;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  throw new Error("MCP: stream ended without response");
}

function authHeader(cfg: McpServerConfig): string | null {
  if (cfg.auth === "bearer" && cfg.bearer) return `Bearer ${cfg.bearer}`;
  if (cfg.auth === "oauth" && cfg.oauth?.accessToken)
    return `Bearer ${cfg.oauth.accessToken}`;
  return null;
}

export async function connect(cfg: McpServerConfig): Promise<McpTool[]> {
  const session: Session = { rpcId: 0, tools: [] };
  sessions.set(cfg.id, session);

  await rpc(cfg, session, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    clientInfo: CLIENT_INFO,
  });
  await rpc(cfg, session, "notifications/initialized", undefined, true);

  const result = await rpc<{
    tools: { name: string; description?: string; inputSchema?: unknown }[];
  }>(cfg, session, "tools/list");

  session.tools = result.tools.map((t) => ({
    serverId: cfg.id,
    serverName: cfg.name,
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    inputSchema: t.inputSchema,
  }));
  return session.tools;
}

export async function callTool(
  serverId: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const cfg = await Mcps.get(serverId);
  if (!cfg) throw new Error(`MCP server ${serverId} not found`);
  let session = sessions.get(serverId);
  if (!session) {
    await connect(cfg);
    session = sessions.get(serverId);
  }
  if (!session) throw new Error("MCP: failed to open session");

  const result = await rpc<{
    content?: { type: string; text?: string }[];
    isError?: boolean;
  }>(cfg, session, "tools/call", { name, arguments: args ?? {} }, false, signal);

  const parts = (result.content ?? [])
    .map((c) => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
    .join("\n");
  return parts || (result.isError ? "Tool returned error" : "(empty result)");
}

export function listLoadedTools(serverId: string): McpTool[] {
  return sessions.get(serverId)?.tools ?? [];
}

export function disconnect(serverId: string) {
  sessions.delete(serverId);
}

// ---------------- OAuth (PKCE + DCR) ----------------

async function runOAuth(cfg: McpServerConfig): Promise<void> {
  const state = cfg.oauth ?? {};
  if (!state.authorizationEndpoint || !state.tokenEndpoint) {
    await discover(cfg, state);
  }
  if (!state.clientId && state.registrationEndpoint) {
    await registerClient(state);
  }
  if (!state.clientId)
    throw new Error("OAuth: no client_id and registration not supported");

  if (
    state.accessToken &&
    state.expiresAt &&
    Date.now() < state.expiresAt - 60_000
  ) {
    cfg.oauth = state;
    await Mcps.put(cfg);
    return;
  }
  if (state.refreshToken) {
    try {
      await refresh(state);
      cfg.oauth = state;
      await Mcps.put(cfg);
      return;
    } catch {
      /* fall through to interactive */
    }
  }

  const { verifier, challenge } = await pkce();
  const csrf = randomString(16);
  const url = new URL(state.authorizationEndpoint!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", state.clientId!);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", csrf);
  url.searchParams.set("resource", cfg.url);
  if (state.scope) url.searchParams.set("scope", state.scope);

  const code = await openAndAwaitCode(url.toString(), csrf);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    client_id: state.clientId!,
    code_verifier: verifier,
  });
  if (state.clientSecret) body.set("client_secret", state.clientSecret);

  const tokRes = await fetch(state.tokenEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tokRes.ok)
    throw new Error(`OAuth token: ${tokRes.status} ${await tokRes.text()}`);
  const tok = await tokRes.json();
  state.accessToken = tok.access_token;
  state.refreshToken = tok.refresh_token ?? state.refreshToken;
  state.expiresAt = Date.now() + (tok.expires_in ?? 3600) * 1000;
  cfg.oauth = state;
  await Mcps.put(cfg);
}

async function discover(cfg: McpServerConfig, state: OAuthState) {
  const base = new URL(cfg.url);
  const resourceMeta = await tryFetchJson(
    `${base.origin}/.well-known/oauth-protected-resource`,
  );
  const authServer: string | undefined =
    resourceMeta?.authorization_servers?.[0];
  const asBase = authServer ? new URL(authServer).origin : base.origin;

  const asMeta = await tryFetchJson(
    `${asBase}/.well-known/oauth-authorization-server`,
  );
  if (!asMeta) throw new Error("OAuth: could not discover authorization server");
  state.authorizationEndpoint = asMeta.authorization_endpoint;
  state.tokenEndpoint = asMeta.token_endpoint;
  state.registrationEndpoint = asMeta.registration_endpoint;
  state.scope = (asMeta.scopes_supported ?? []).join(" ") || state.scope;
}

async function tryFetchJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function registerClient(state: OAuthState) {
  const res = await fetch(state.registrationEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "MCP Chat",
      redirect_uris: [redirectUri()],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!res.ok) throw new Error(`DCR ${res.status}: ${await res.text()}`);
  const j = await res.json();
  state.clientId = j.client_id;
  state.clientSecret = j.client_secret;
}

async function refresh(state: OAuthState) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.refreshToken!,
    client_id: state.clientId!,
  });
  if (state.clientSecret) body.set("client_secret", state.clientSecret);
  const r = await fetch(state.tokenEndpoint!, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) throw new Error(`refresh ${r.status}`);
  const t = await r.json();
  state.accessToken = t.access_token;
  if (t.refresh_token) state.refreshToken = t.refresh_token;
  state.expiresAt = Date.now() + (t.expires_in ?? 3600) * 1000;
}

async function openAndAwaitCode(
  authUrl: string,
  expectedState: string,
): Promise<string> {
  if (isNative()) {
    return new Promise<string>((resolve, reject) => {
      let handle: { remove: () => Promise<void> } | null = null;
      const timeout = setTimeout(() => {
        handle?.remove();
        reject(new Error("OAuth timeout"));
      }, 5 * 60_000);

      App.addListener("appUrlOpen", async (event) => {
        try {
          const u = new URL(event.url);
          if (!u.toString().startsWith("mcpchat://oauth-callback")) return;
          const code = u.searchParams.get("code");
          const state = u.searchParams.get("state");
          if (!code) return reject(new Error("No code in callback"));
          if (state !== expectedState)
            return reject(new Error("CSRF state mismatch"));
          clearTimeout(timeout);
          handle?.remove();
          await Browser.close();
          resolve(code);
        } catch (e) {
          reject(e as Error);
        }
      }).then((h) => {
        handle = h;
      });

      Browser.open({ url: authUrl, presentationStyle: "popover" }).catch(
        reject,
      );
    });
  }

  const popup = window.open(authUrl, "_blank", "width=480,height=720");
  if (!popup) throw new Error("Popup blocked");
  return new Promise<string>((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        if (popup.closed) {
          clearInterval(timer);
          reject(new Error("OAuth popup closed"));
          return;
        }
        const href = popup.location.href;
        if (href.startsWith(redirectUri())) {
          const u = new URL(href);
          const code = u.searchParams.get("code");
          const state = u.searchParams.get("state");
          clearInterval(timer);
          popup.close();
          if (!code) return reject(new Error("No code in callback"));
          if (state !== expectedState)
            return reject(new Error("CSRF state mismatch"));
          resolve(code);
        }
      } catch {
        /* cross-origin until redirect lands */
      }
    }, 500);
  });
}

async function pkce() {
  const verifier = randomString(64);
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

function randomString(len: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return base64url(bytes).slice(0, len);
}

function base64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
