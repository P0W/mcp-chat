import { useEffect, useState } from "react";
import { Providers as Db, uid } from "../db";
import type { LlmProtocol, ProviderConfig } from "../types";

const PRESETS: {
  name: string;
  baseUrl: string;
  model: string;
  protocol: LlmProtocol;
}[] = [
  {
    name: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-6",
    protocol: "anthropic",
  },
  {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    protocol: "openai",
  },
  {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.0-flash",
    protocol: "openai",
  },
  {
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "openai",
  },
  {
    name: "Moonshot Kimi",
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2-0905-preview",
    protocol: "openai",
  },
  {
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openrouter/auto",
    protocol: "openai",
  },
];

export default function Providers({ onChange }: { onChange: () => void }) {
  const [list, setList] = useState<ProviderConfig[]>([]);
  const [editing, setEditing] = useState<ProviderConfig | null>(null);

  async function reload() {
    setList(await Db.list());
  }
  useEffect(() => {
    void reload();
  }, []);

  function startNew(preset?: (typeof PRESETS)[number]) {
    setEditing({
      id: uid(),
      name: preset?.name ?? "",
      protocol: preset?.protocol ?? "openai",
      baseUrl: preset?.baseUrl ?? "",
      apiKey: "",
      model: preset?.model ?? "",
    });
  }

  async function save() {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseUrl.trim() || !editing.model.trim()) {
      alert("Name, base URL and model are required.");
      return;
    }
    await Db.put(editing);
    setEditing(null);
    await reload();
    onChange();
  }

  async function remove(id: string) {
    if (!confirm("Delete this provider?")) return;
    await Db.remove(id);
    await reload();
  }

  if (editing) {
    return (
      <div className="h-full overflow-y-auto p-4 space-y-3">
        <h2 className="text-base font-semibold">Provider</h2>

        <label className="label">Name</label>
        <input
          className="input"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />

        <label className="label">Protocol</label>
        <select
          className="input"
          value={editing.protocol}
          onChange={(e) =>
            setEditing({ ...editing, protocol: e.target.value as LlmProtocol })
          }
        >
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>

        <label className="label">Base URL</label>
        <input
          className="input"
          placeholder="https://api.example.com/v1"
          value={editing.baseUrl}
          onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
        />

        <label className="label">Model</label>
        <input
          className="input"
          value={editing.model}
          onChange={(e) => setEditing({ ...editing, model: e.target.value })}
        />

        <label className="label">API key</label>
        <input
          className="input"
          type="password"
          autoComplete="off"
          value={editing.apiKey}
          onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
        />

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
        <h2 className="text-base font-semibold">Providers</h2>
        <button className="btn btn-primary" onClick={() => startNew()}>
          + Custom
        </button>
      </div>

      {list.length === 0 && (
        <p className="text-sm text-neutral-400">
          Pick a preset to get started:
        </p>
      )}

      {list.map((p) => (
        <div key={p.id} className="card flex items-center justify-between">
          <div>
            <div className="font-medium text-sm">{p.name}</div>
            <div className="text-xs text-neutral-500">
              {p.protocol} · {p.model}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="btn-ghost text-sm text-indigo-400"
              onClick={() => setEditing(p)}
            >
              Edit
            </button>
            <button
              className="btn-ghost text-sm text-red-400"
              onClick={() => void remove(p.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}

      <div className="pt-3">
        <div className="label">Presets</div>
        <div className="grid grid-cols-2 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.name}
              className="card text-left hover:border-indigo-500"
              onClick={() => startNew(p)}
            >
              <div className="font-medium text-sm">{p.name}</div>
              <div className="text-xs text-neutral-500 truncate">{p.model}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
