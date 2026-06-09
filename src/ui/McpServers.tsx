import { useEffect, useState } from "react";
import { Mcps as Db, uid } from "../db";
import { connect, disconnect } from "../mcp";
import type { McpAuthMode, McpServerConfig, OAuthState } from "../types";

interface Preset {
  name: string;
  url: string;
  auth: McpAuthMode;
  oauth?: OAuthState;
  note?: string;
}

const PRESETS: Preset[] = [
  { name: "Zerodha Kite", url: "https://mcp.kite.trade/mcp", auth: "oauth" },
  {
    name: "Google Drive",
    url: "",
    auth: "oauth",
    oauth: {
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    },
    note:
      "Google has no dynamic client registration, so the one-tap flow can't work. " +
      "Enter the URL of a Google Drive MCP server plus a Client ID you create in " +
      "Google Cloud Console (the OAuth endpoints and Drive scope are pre-filled).",
  },
];

interface Status {
  state: "idle" | "connecting" | "ok" | "error";
  message?: string;
  toolCount?: number;
}

export default function McpServers() {
  const [list, setList] = useState<McpServerConfig[]>([]);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});

  async function reload() {
    setList(await Db.list());
  }
  useEffect(() => {
    void reload();
  }, []);

  function startNew(preset?: Preset) {
    setEditing({
      id: uid(),
      name: preset?.name ?? "",
      url: preset?.url ?? "",
      auth: preset?.auth ?? "none",
      oauth: preset?.oauth ? { ...preset.oauth } : undefined,
      enabled: true,
    });
  }

  async function save() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.url.trim()) {
      alert("Name and URL are required.");
      return;
    }
    await Db.put(editing);
    setEditing(null);
    await reload();
  }

  async function remove(id: string) {
    if (!confirm("Delete this MCP server?")) return;
    disconnect(id);
    await Db.remove(id);
    await reload();
  }

  async function testConnect(s: McpServerConfig) {
    setStatus((m) => ({ ...m, [s.id]: { state: "connecting" } }));
    try {
      disconnect(s.id);
      const tools = await connect(s);
      setStatus((m) => ({
        ...m,
        [s.id]: { state: "ok", toolCount: tools.length },
      }));
      // Persist (oauth state may have been updated)
      await reload();
    } catch (e) {
      setStatus((m) => ({
        ...m,
        [s.id]: { state: "error", message: (e as Error).message },
      }));
    }
  }

  async function toggleEnabled(s: McpServerConfig) {
    await Db.put({ ...s, enabled: !s.enabled });
    if (s.enabled) disconnect(s.id);
    await reload();
  }

  function patchOauth(patch: Partial<OAuthState>) {
    setEditing((cur) =>
      cur ? { ...cur, oauth: { ...cur.oauth, ...patch } } : cur,
    );
  }

  if (editing) {
    return (
      <div className="h-full overflow-y-auto p-4 space-y-3">
        <h2 className="text-base font-semibold">MCP Server</h2>

        <label className="label">Name</label>
        <input
          className="input"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />

        <label className="label">URL</label>
        <input
          className="input"
          placeholder="https://example.com/mcp"
          value={editing.url}
          onChange={(e) => setEditing({ ...editing, url: e.target.value })}
        />

        <label className="label">Auth</label>
        <select
          className="input"
          value={editing.auth}
          onChange={(e) =>
            setEditing({ ...editing, auth: e.target.value as McpAuthMode })
          }
        >
          <option value="none">None</option>
          <option value="bearer">Bearer token</option>
          <option value="oauth">OAuth 2.1 (auto-discover)</option>
        </select>

        {editing.auth === "bearer" && (
          <>
            <label className="label">Token</label>
            <input
              className="input"
              type="password"
              value={editing.bearer ?? ""}
              onChange={(e) =>
                setEditing({ ...editing, bearer: e.target.value })
              }
            />
          </>
        )}

        {editing.auth === "oauth" && (
          <>
            <p className="text-xs text-neutral-400">
              Leave these blank to use automatic discovery + dynamic
              registration (works for servers that host their own OAuth app,
              e.g. Kite). Fill them in for providers like Google that require a
              pre-registered Client ID.
            </p>

            <label className="label">Client ID</label>
            <input
              className="input"
              placeholder="optional — required by Google etc."
              value={editing.oauth?.clientId ?? ""}
              onChange={(e) =>
                patchOauth({ clientId: e.target.value || undefined })
              }
            />

            <label className="label">Client secret</label>
            <input
              className="input"
              type="password"
              placeholder="optional — only for confidential clients"
              value={editing.oauth?.clientSecret ?? ""}
              onChange={(e) =>
                patchOauth({ clientSecret: e.target.value || undefined })
              }
            />

            <label className="label">Scope</label>
            <input
              className="input"
              placeholder="optional — space-separated scopes"
              value={editing.oauth?.scope ?? ""}
              onChange={(e) =>
                patchOauth({ scope: e.target.value || undefined })
              }
            />

            <label className="label">Authorization endpoint</label>
            <input
              className="input"
              placeholder="optional — auto-discovered if blank"
              value={editing.oauth?.authorizationEndpoint ?? ""}
              onChange={(e) =>
                patchOauth({
                  authorizationEndpoint: e.target.value || undefined,
                })
              }
            />

            <label className="label">Token endpoint</label>
            <input
              className="input"
              placeholder="optional — auto-discovered if blank"
              value={editing.oauth?.tokenEndpoint ?? ""}
              onChange={(e) =>
                patchOauth({ tokenEndpoint: e.target.value || undefined })
              }
            />

            {editing.oauth?.accessToken && (
              <div className="text-xs text-emerald-400">
                Authorized · token expires{" "}
                {editing.oauth.expiresAt
                  ? new Date(editing.oauth.expiresAt).toLocaleString()
                  : "?"}
              </div>
            )}
          </>
        )}

        <div className="flex gap-2 pt-2">
          <button className="btn btn-primary flex-1" onClick={() => void save()}>
            Save
          </button>
          <button className="btn flex-1" onClick={() => setEditing(null)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">MCP Servers</h2>
        <button className="btn btn-primary" onClick={() => startNew()}>
          + Add
        </button>
      </div>

      {list.length === 0 && (
        <p className="text-sm text-neutral-400">No MCP servers yet.</p>
      )}

      {list.map((s) => {
        const st = status[s.id] ?? { state: "idle" as const };
        return (
          <div key={s.id} className="card">
            <div className="flex items-start justify-between">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{s.name}</div>
                <div className="text-xs text-neutral-500 truncate">{s.url}</div>
                <div className="text-xs text-neutral-500 mt-1">
                  auth: {s.auth} · {s.enabled ? "enabled" : "disabled"}
                </div>
                {st.state === "ok" && (
                  <div className="text-xs text-emerald-400 mt-1">
                    ✓ {st.toolCount} tools
                  </div>
                )}
                {st.state === "connecting" && (
                  <div className="text-xs text-indigo-400 mt-1">connecting…</div>
                )}
                {st.state === "error" && (
                  <div className="text-xs text-red-400 mt-1 break-words">
                    {st.message}
                  </div>
                )}
              </div>
              <label className="flex items-center gap-1 text-xs ml-2">
                <input
                  type="checkbox"
                  checked={s.enabled}
                  onChange={() => void toggleEnabled(s)}
                />
                on
              </label>
            </div>
            <div className="flex gap-2 mt-2">
              <button
                className="btn-ghost text-sm text-indigo-400"
                onClick={() => void testConnect(s)}
              >
                {s.auth === "oauth" && !s.oauth?.accessToken
                  ? "Authorize & test"
                  : "Test"}
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={() => setEditing(s)}
              >
                Edit
              </button>
              <button
                className="btn-ghost text-sm text-red-400 ml-auto"
                onClick={() => void remove(s.id)}
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}

      <div className="pt-3">
        <div className="label">Presets</div>
        <div className="grid grid-cols-1 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="card text-left hover:border-indigo-500"
              onClick={() => startNew(p)}
            >
              <div className="font-medium text-sm">{p.name}</div>
              <div className="text-xs text-neutral-500 truncate">
                {p.url || "configure URL + Client ID"}
              </div>
              {p.note && (
                <div className="text-xs text-neutral-500 mt-1">{p.note}</div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
