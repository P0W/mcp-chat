import { useEffect, useRef, useState } from "react";
import { Chats, Mcps, Meta, Providers, uid } from "../db";
import { runChat } from "../llm";
import { callTool, connect, listLoadedTools } from "../mcp";
import type {
  Chat as ChatT,
  ChatMessage,
  McpTool,
  ProviderConfig,
} from "../types";
import Markdown from "./Markdown";

const SYSTEM_PROMPT = `You are connected to the user's MCP tool servers.

Rules:
- When a user asks for data any tool could provide, CALL THE TOOL. Don't announce "I will now call the tool" — just call it.
- Never fabricate URLs, tokens, or data. If you need a URL (e.g. OAuth login), call the tool and quote what it returns verbatim.
- If no tool fits, reply: "No available tool can do this."

Formatting:
- Tabular data → compact markdown table, no prose preamble.
- Money in ₹ → no spaces inside the symbol, use Indian grouping (1,23,456.78).
- No trailing "please note..." disclaimers, no caveats about subsets unless the data is actually truncated.
- No step-by-step calculation explanations unless explicitly asked.
- Be terse. One table or one short paragraph is enough.`;

export default function Chat({
  hasProvider,
  goSettings,
}: {
  hasProvider: boolean;
  goSettings: (v: "providers" | "mcps") => void;
}) {
  const [chat, setChat] = useState<ChatT | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [mcpErrors, setMcpErrors] = useState<{ name: string; msg: string }[]>(
    [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ChatT[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const list = await Providers.list();
      setProviders(list);
      const lastChatId = await Meta.get<string>("lastChatId");
      const existing = lastChatId ? await Chats.get(lastChatId) : null;
      if (existing) {
        setChat(existing);
      } else if (list.length) {
        setChat(newChat(list[0].id));
      }
      setHistory(await Chats.list());
      await loadAllTools();
    })();
  }, []);

  useEffect(() => {
    if (scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [chat?.messages.length, busy]);

  async function loadAllTools() {
    const servers = (await Mcps.list()).filter((s) => s.enabled);
    const all: McpTool[] = [];
    const errs: { name: string; msg: string }[] = [];
    for (const s of servers) {
      try {
        const cached = listLoadedTools(s.id);
        if (cached.length) {
          all.push(...cached);
          continue;
        }
        const t = await connect(s);
        all.push(...t);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        console.warn(`MCP ${s.name} connect failed:`, e);
        errs.push({ name: s.name, msg });
      }
    }
    setTools(all);
    setMcpErrors(errs);
  }

  function newChat(providerId: string): ChatT {
    return {
      id: uid(),
      title: "New chat",
      providerId,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  async function send() {
    if (!input.trim() || !chat || busy) return;
    const provider = providers.find((p) => p.id === chat.providerId);
    if (!provider) {
      setError("No provider selected.");
      return;
    }

    setError(null);
    setBusy(true);
    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content: input.trim(),
      createdAt: Date.now(),
    };
    const next: ChatT = {
      ...chat,
      messages: [...chat.messages, userMsg],
      title: chat.messages.length === 0 ? userMsg.content.slice(0, 40) : chat.title,
      updatedAt: Date.now(),
    };
    setChat(next);
    setInput("");

    try {
      const working = [...next.messages];
      await runChat({
        provider,
        systemPrompt: SYSTEM_PROMPT,
        messages: working,
        tools,
        runner: { call: callTool },
        onAssistant: (m) =>
          setChat((c) => (c ? { ...c, messages: [...c.messages, m] } : c)),
        onToolResult: (m) =>
          setChat((c) => (c ? { ...c, messages: [...c.messages, m] } : c)),
      });

      setChat((c) => {
        if (!c) return c;
        const finalChat = { ...c, updatedAt: Date.now() };
        void Chats.put(finalChat);
        void Meta.set("lastChatId", finalChat.id);
        return finalChat;
      });
      setHistory(await Chats.list());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function startNewChat() {
    if (!providers.length) return;
    const c = newChat(chat?.providerId ?? providers[0].id);
    setChat(c);
    setShowHistory(false);
  }

  if (!hasProvider) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h2 className="text-lg font-semibold mb-2">Welcome to MCP Chat</h2>
        <p className="text-sm text-neutral-400 mb-6">
          Add an LLM provider to get started.
        </p>
        <button className="btn btn-primary" onClick={() => goSettings("providers")}>
          Configure provider
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800">
        <button
          className="btn-ghost text-sm text-neutral-300 truncate max-w-[60%]"
          onClick={() => setShowHistory((s) => !s)}
        >
          {chat?.title ?? "New chat"}
        </button>
        <div className="flex items-center gap-2">
          {chat && providers.length > 1 && (
            <select
              className="bg-neutral-900 border border-neutral-800 rounded-lg text-xs px-2 py-1"
              value={chat.providerId}
              onChange={(e) =>
                setChat({ ...chat, providerId: e.target.value })
              }
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn-ghost text-sm" onClick={startNewChat}>
            + New
          </button>
        </div>
      </div>

      {showHistory && (
        <div className="border-b border-neutral-800 max-h-60 overflow-y-auto bg-neutral-950">
          {history.length === 0 && (
            <div className="p-3 text-sm text-neutral-500">No past chats</div>
          )}
          {history.map((h) => (
            <button
              key={h.id}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-neutral-900 truncate"
              onClick={() => {
                setChat(h);
                setShowHistory(false);
              }}
            >
              {h.title}
            </button>
          ))}
        </div>
      )}

      {mcpErrors.length > 0 && (
        <div className="px-3 pt-2 space-y-1">
          {mcpErrors.map((e) => (
            <div
              key={e.name}
              className="text-xs text-red-300 bg-red-950/40 border border-red-900/40 rounded-lg px-2 py-1.5 flex items-start justify-between gap-2"
            >
              <span className="break-words">
                <span className="font-medium">{e.name}:</span> {e.msg}
              </span>
              <button
                className="shrink-0 text-red-200 underline"
                onClick={() => void loadAllTools()}
              >
                retry
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
        {chat?.messages.length === 0 && (
          <div className="text-center text-sm text-neutral-500 mt-12">
            {tools.length} MCP tool{tools.length === 1 ? "" : "s"} available.
            Ask anything.
          </div>
        )}
        {chat?.messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-neutral-500 px-2">
            <span className="inline-block w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />
            Thinking...
          </div>
        )}
        {error && (
          <div className="text-sm text-red-400 px-2 py-1 bg-red-950/40 rounded-lg">
            {error}
          </div>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3 bg-neutral-950">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !busy) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message..."
            rows={1}
            className="input resize-none max-h-40"
            style={{ minHeight: "2.5rem" }}
          />
          <button
            className="btn btn-primary"
            disabled={busy || !input.trim()}
            onClick={() => void send()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2 text-sm whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <details className="text-xs text-neutral-400">
        <summary className="cursor-pointer select-none px-2">
          tool · {(msg.toolName ?? "").split("__").pop()}
        </summary>
        <pre className="mt-1 mx-2 bg-neutral-900 p-2 rounded-lg overflow-x-auto whitespace-pre-wrap text-[11px]">
          {msg.content}
        </pre>
      </details>
    );
  }
  if (msg.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-2xl rounded-bl-md bg-neutral-900 border border-neutral-800 px-4 py-2 text-sm">
          {msg.toolCalls?.length ? (
            <div className="text-xs text-neutral-400 mb-1">
              calling{" "}
              {msg.toolCalls
                .map((t) => t.name.split("__").pop() ?? t.name)
                .join(", ")}
            </div>
          ) : null}
          {msg.content && <Markdown text={msg.content} />}
        </div>
      </div>
    );
  }
  return null;
}
