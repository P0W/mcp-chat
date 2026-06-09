import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Chats, Mcps, Meta, Providers, uid } from "../db";
import { runChat, type CompactInfo } from "../llm";
import { callTool, connect, listLoadedTools } from "../mcp";
import { LOCAL_SERVER_ID, callLocalTool, localTools } from "../localTools";
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

const isNative = () => Capacitor.isNativePlatform();
const IS_NATIVE = isNative();

// Route a tool call to the local built-in tools or the matching MCP server.
const runToolCall = (
  serverId: string,
  name: string,
  args: unknown,
  signal?: AbortSignal,
) =>
  serverId === LOCAL_SERVER_ID
    ? callLocalTool(name, args)
    : callTool(serverId, name, args, signal);

export default function Chat({
  hasProvider,
  goSettings,
}: {
  hasProvider: boolean;
  goSettings: (v: "providers" | "mcps") => void;
}) {
  const [chat, setChat] = useState<ChatT | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [tools, setTools] = useState<McpTool[]>(localTools);
  const [mcpErrors, setMcpErrors] = useState<{ name: string; msg: string }[]>(
    [],
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [queuedMessages, setQueuedMessages] = useState<ChatMessage[]>([]);
  const [history, setHistory] = useState<ChatT[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState<CompactInfo | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const chatRef = useRef<ChatT | null>(null);
  const queuedRef = useRef<ChatMessage[]>([]);
  const runningRef = useRef(false);

  function setActiveChat(next: ChatT | null) {
    chatRef.current = next;
    setChat(next);
  }

  function appendMessages(base: ChatT, messages: ChatMessage[]): ChatT {
    const firstUser = messages.find((m) => m.role === "user");
    return {
      ...base,
      messages: [...base.messages, ...messages],
      title:
        base.messages.length === 0 && firstUser
          ? firstUser.content.slice(0, 40)
          : base.title,
      updatedAt: Date.now(),
    };
  }

  function appendMessagesToChat(chatId: string, messages: ChatMessage[]) {
    const current = chatRef.current;
    if (!current || current.id !== chatId) return;
    setActiveChat(appendMessages(current, messages));
  }

  function drainQueuedMessages(): ChatMessage[] {
    const queued = queuedRef.current;
    if (!queued.length) return [];
    queuedRef.current = [];
    setQueuedMessages([]);
    return queued;
  }

  useEffect(() => {
    void (async () => {
      const list = await Providers.list();
      setProviders(list);
      const lastChatId = await Meta.get<string>("lastChatId");
      const existing = lastChatId ? await Chats.get(lastChatId) : null;
      if (existing) {
        setActiveChat(existing);
      } else {
        if (list[0]) setActiveChat(newChat(list[0].id));
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
    const all: McpTool[] = [...localTools];
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
    const content = input.trim();
    const activeChat = chatRef.current;
    if (!content || !activeChat) return;

    const userMsg: ChatMessage = {
      id: uid(),
      role: "user",
      content,
      createdAt: Date.now(),
    };
    setInput("");
    setError(null);

    if (runningRef.current) {
      const queued = [...queuedRef.current, userMsg];
      queuedRef.current = queued;
      setQueuedMessages(queued);
      return;
    }

    await runConversation([userMsg]);
  }

  async function runConversation(initialMessages: ChatMessage[]) {
    const activeChat = chatRef.current;
    if (!activeChat) return;
    const chatId = activeChat.id;
    const provider = providers.find((p) => p.id === activeChat.providerId);
    if (!provider) {
      setError("No provider selected.");
      return;
    }

    runningRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let pending = initialMessages;

    try {
      while (pending.length) {
        appendMessagesToChat(chatId, pending);
        const current = chatRef.current;
        if (!current || current.id !== chatId) return;
        const working = [...current.messages];
        await runChat({
          provider,
          systemPrompt: SYSTEM_PROMPT,
          messages: working,
          tools,
          runner: { call: runToolCall },
          signal: controller.signal,
          drainQueuedMessages,
          onQueuedMessages: (messages) => appendMessagesToChat(chatId, messages),
          onAssistant: (m) => appendMessagesToChat(chatId, [m]),
          onToolResult: (m) => appendMessagesToChat(chatId, [m]),
          onCompact: setCompact,
        });

        const finalChat = chatRef.current;
        if (finalChat?.id === chatId) {
          await Chats.put(finalChat);
          await Meta.set("lastChatId", finalChat.id);
        }
        setHistory(await Chats.list());
        pending = drainQueuedMessages();
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (!controller.signal.aborted) setError(msg);
    } finally {
      const finalChat = chatRef.current;
      if (finalChat?.id === chatId) {
        await Chats.put(finalChat);
        await Meta.set("lastChatId", finalChat.id);
        setHistory(await Chats.list());
      }
      if (abortRef.current !== controller) return;
      abortRef.current = null;
      runningRef.current = false;
      setBusy(false);
      const continueWith = drainQueuedMessages();
      if (continueWith.length) void runConversation(continueWith);
    }
  }

  function stop() {
    queuedRef.current = [];
    setQueuedMessages([]);
    abortRef.current?.abort();
  }

  function startNewChat() {
    if (!providers.length) return;
    stop();
    const firstProvider = providers[0];
    if (!firstProvider) return;
    const providerId = chat?.providerId ?? firstProvider.id;
    const c = newChat(providerId);
    queuedRef.current = [];
    setQueuedMessages([]);
    setActiveChat(c);
    setShowHistory(false);
    setCompact(null);
    setError(null);
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
      {showHistory && (
        <button
          className="fixed inset-0 z-40 bg-black/50"
          aria-label="Close chat history"
          onClick={() => setShowHistory(false)}
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-80 max-w-[85vw] flex-col border-r border-neutral-800 bg-neutral-950 transition-transform duration-200 ${
          showHistory ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-hidden={!showHistory}
        style={{
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          paddingLeft: "env(safe-area-inset-left)",
          pointerEvents: showHistory ? "auto" : "none",
        }}
      >
        <div className="border-b border-neutral-800 px-4 py-3 text-sm font-medium">
          Chat history
        </div>
        <div className="flex-1 overflow-y-auto">
          {history.length === 0 && (
            <div className="p-3 text-sm text-neutral-500">No past chats</div>
          )}
          {history.map((h) => (
            <button
              key={h.id}
              className="block w-full text-left px-4 py-2 text-sm hover:bg-neutral-900 truncate"
              aria-label={`Open chat: ${h.title}`}
              disabled={!showHistory}
              onClick={() => {
                stop();
                setActiveChat(h);
                setShowHistory(false);
              }}
            >
              {h.title}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800">
        <button
          className="btn-ghost text-sm text-neutral-300 truncate max-w-[55%]"
          onClick={() => setShowHistory((s) => !s)}
        >
          {chat?.title ?? "New chat"}
        </button>
        <div className="flex items-center gap-2">
          {compact && compact.elided > 0 && (
            <span
              className="text-[10px] text-neutral-500"
              title={`Context auto-compacted: ${compact.origTokens.toLocaleString()} → ${compact.finalTokens.toLocaleString()} tokens, ${compact.elided} tool result${compact.elided === 1 ? "" : "s"} elided. Model can re-call tools for full data.`}
            >
              ctx {Math.round(compact.finalTokens / 1000)}k
            </span>
          )}
          {chat && providers.length > 1 && (
            <select
              className="bg-neutral-900 border border-neutral-800 rounded-lg text-xs px-2 py-1"
              value={chat.providerId}
              onChange={(e) =>
                setActiveChat({ ...chat, providerId: e.target.value })
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
            {tools.length} tool{tools.length === 1 ? "" : "s"} available.
            Ask anything.
          </div>
        )}
        {chat?.messages.map((m) => (
          <MessageBubble key={m.id} msg={m} />
        ))}
        {queuedMessages.map((m) => (
          <QueuedMessage key={m.id} msg={m} />
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
              if (IS_NATIVE) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            enterKeyHint={IS_NATIVE ? "enter" : "send"}
            placeholder="Message..."
            rows={1}
            className="input resize-none max-h-40"
            style={{ minHeight: "2.5rem" }}
          />
          {busy && (
            <button className="btn" onClick={stop} title="Stop">
              Stop
            </button>
          )}
          <button
            className="btn btn-primary aspect-square px-2.5"
            disabled={!input.trim() || !chat}
            aria-label={busy ? "Queue message" : "Send message"}
            title={busy ? "Queue message" : "Send message"}
            onClick={() => void send()}
          >
            <ArrowUpIcon />
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
          tool · {msg.toolName ?? ""}
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

function QueuedMessage({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex justify-end opacity-70">
      <div className="max-w-[85%] rounded-2xl rounded-br-md border border-indigo-500/50 bg-indigo-600/40 px-4 py-2 text-sm whitespace-pre-wrap">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-indigo-100/80">
          queued
        </div>
        {msg.content}
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <path d="M10 16V4" />
      <path d="M5 9l5-5 5 5" />
    </svg>
  );
}
