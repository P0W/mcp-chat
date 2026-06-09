import { useEffect, useState } from "react";
import { Providers as ProvidersDb } from "./db";
import Chat from "./ui/Chat";
import Providers from "./ui/Providers";
import McpServers from "./ui/McpServers";
import About from "./ui/About";

type View = "chat" | "providers" | "mcps" | "about";

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [hasProvider, setHasProvider] = useState<boolean | null>(null);

  // First-launch helper: if no provider configured yet, nudge to providers tab
  useEffect(() => {
    void (async () => {
      const list = await ProvidersDb.list();
      setHasProvider(list.length > 0);
      if (list.length === 0) setView("providers");
    })();
  }, []);

  return (
    <div className="flex h-full flex-col bg-neutral-950">
      <Tabs view={view} setView={setView} />
      <div className="flex-1 overflow-hidden">
        {view === "chat" && (
          <Chat hasProvider={hasProvider ?? false} goSettings={(v) => setView(v)} />
        )}
        {view === "providers" && (
          <Providers onChange={() => setHasProvider(true)} />
        )}
        {view === "mcps" && <McpServers />}
        {view === "about" && <About />}
      </div>
    </div>
  );
}

function Tabs({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  const tabs: { id: View; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "providers", label: "Providers" },
    { id: "mcps", label: "MCP" },
    { id: "about", label: "About" },
  ];
  return (
    <div className="flex border-b border-neutral-800 bg-neutral-950/95 backdrop-blur sticky top-0 z-10">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setView(t.id)}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            view === t.id
              ? "text-indigo-400 border-b-2 border-indigo-500"
              : "text-neutral-400"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
