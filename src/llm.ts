import type {
  ChatMessage,
  LlmProtocol,
  McpTool,
  ProviderConfig,
  ToolCall,
} from "./types";

export interface ToolRunner {
  call(
    serverId: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface RunOptions {
  provider: ProviderConfig;
  systemPrompt?: string;
  messages: ChatMessage[];
  tools: McpTool[];
  runner: ToolRunner;
  onAssistant: (msg: ChatMessage) => void;
  onToolResult: (msg: ChatMessage) => void;
  onCompact?: (info: CompactInfo) => void;
  maxIterations?: number;
  contextBudgetTokens?: number;
  signal?: AbortSignal;
  drainQueuedMessages?: () => ChatMessage[];
  onQueuedMessages?: (messages: ChatMessage[]) => void;
}

export interface CompactInfo {
  origTokens: number;
  finalTokens: number;
  elided: number;
}

// Conservative default — fits Llama 4 Scout (32k), modest for everyone else.
// Per-provider override later via provider.contextLimit if needed.
const DEFAULT_BUDGET_TOKENS = 28_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const CHARS_PER_TOKEN = 4;
const ELIDABLE_MIN_BYTES = 500;
const ELIDED_PREFIX = "[Elided tool result";

const TOOL_NAME_RE = /[^a-zA-Z0-9_-]/g;
const TOOL_KEY_MAX = 64;
// Fixed-width base36 FNV-1a hash (32-bit → at most 7 base36 chars).
const TOOL_KEY_HASH_LEN = 7;
type LlmCallResult = { message: ChatMessage };
type ProtocolCaller = (opts: RunOptions) => Promise<LlmCallResult>;

const PROTOCOL_CALLERS: Record<LlmProtocol, ProtocolCaller> = {
  openai: callOpenAICompatible,
  anthropic: callMessagesCompatible,
};

// FNV-1a (32-bit), returned as zero-padded base36 so the discriminator is a
// fixed width that depends on the *entire* input, not a truncated prefix.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(TOOL_KEY_HASH_LEN, "0");
}

// Advertise a stable, provider-safe tool name. The readable tool name comes
// first (for legibility), followed by a hash of the full (serverId, name)
// identity. Because the hash covers the *complete* identity — not a truncated
// prefix of either field — two distinct tools cannot collide even if their
// readable names are truncated to the same prefix or their serverIds share a
// prefix. parseToolKey recomputes this key, so the mapping round-trips.
function toolKey(t: McpTool): string {
  const disc = fnv1a(`${t.serverId}\u0000${t.name}`);
  const name = t.name
    .replace(TOOL_NAME_RE, "_")
    .slice(0, TOOL_KEY_MAX - disc.length - 2);
  return `${name}__${disc}`;
}

function parseToolKey(
  key: string,
  tools: McpTool[],
): { tool: McpTool } | null {
  const match = tools.find((t) => toolKey(t) === key);
  return match ? { tool: match } : null;
}

function uid() {
  return crypto.randomUUID();
}

export async function runChat(opts: RunOptions): Promise<void> {
  const max = opts.maxIterations ?? 8;
  const budget = opts.contextBudgetTokens ?? DEFAULT_BUDGET_TOKENS;

  for (let i = 0; i < max; i++) {
    throwIfAborted(opts.signal);
    // Compact prompt only if it would exceed budget. Protects the current
    // turn (everything from the last user message onward) and only elides
    // older tool results — replaced with a marker telling the model to
    // re-call the tool if it needs that data. Originals stay in IndexedDB.
    const baseline =
      (opts.systemPrompt?.length ?? 0) + estimateToolDefsBytes(opts.tools);
    const compact = compactMessages(opts.messages, baseline, budget);
    if (compact.elided > 0 && opts.onCompact) opts.onCompact(compact);

    const callOpts: RunOptions = { ...opts, messages: compact.messages };
    const result = await PROTOCOL_CALLERS[opts.provider.protocol](callOpts);

    opts.onAssistant(result.message);
    opts.messages.push(result.message);

    const canContinue = i < max - 1;
    if (!result.message.toolCalls || result.message.toolCalls.length === 0) {
      if (canContinue && appendQueuedMessages(opts)) continue;
      return;
    }

    for (const tc of result.message.toolCalls) {
      throwIfAborted(opts.signal);
      const parsed = parseToolKey(tc.name, opts.tools);
      let content: string;
      if (!parsed) {
        content = `Error: unknown tool "${tc.name}"`;
      } else {
        try {
          content = await opts.runner.call(
            parsed.tool.serverId,
            parsed.tool.name,
            tc.args,
            opts.signal,
          );
        } catch (e) {
          throwIfAborted(opts.signal);
          content = `Error: ${(e as Error).message}`;
        }
      }
      const toolMsg: ChatMessage = {
        id: uid(),
        role: "tool",
        content,
        toolCallId: tc.id,
        toolName: parsed?.tool.name ?? tc.name,
        createdAt: Date.now(),
      };
      opts.onToolResult(toolMsg);
      opts.messages.push(toolMsg);
    }
    if (canContinue) appendQueuedMessages(opts);
  }
}

function appendQueuedMessages(opts: RunOptions): boolean {
  const queued = opts.drainQueuedMessages?.() ?? [];
  if (!queued.length) return false;
  opts.messages.push(...queued);
  opts.onQueuedMessages?.(queued);
  return true;
}

function buildToolDefs(tools: McpTool[], protocol: "openai" | "anthropic") {
  if (protocol === "anthropic") {
    return tools.map((t) => ({
      name: toolKey(t),
      description: t.description ?? "",
      input_schema: t.inputSchema ?? { type: "object", properties: {} },
    }));
  }
  return tools.map((t) => ({
    type: "function",
    function: {
      name: toolKey(t),
      description: t.description ?? "",
      parameters: t.inputSchema ?? { type: "object", properties: {} },
    },
  }));
}

async function callOpenAICompatible(opts: RunOptions): Promise<LlmCallResult> {
  const oaiMessages: unknown[] = [];
  if (opts.systemPrompt)
    oaiMessages.push({ role: "system", content: opts.systemPrompt });

  for (const m of opts.messages) {
    if (m.role === "tool") {
      oaiMessages.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content,
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      oaiMessages.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
    } else if (m.role === "user" || m.role === "assistant") {
      oaiMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: opts.provider.model,
    messages: oaiMessages,
    max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (opts.tools.length)
    body.tools = buildToolDefs(opts.tools, "openai");

  const res = await fetchWithRetry(
    `${trimSlash(opts.provider.baseUrl)}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.provider.apiKey}`,
        ...(opts.provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );

  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const choice = json.choices?.[0]?.message;
  if (!choice) throw new Error("No choice in response");

  const toolCalls: ToolCall[] | undefined = choice.tool_calls?.map((tc: {
    id: string;
    function: { name: string; arguments: string };
  }) => ({
    id: tc.id,
    name: tc.function.name,
    args: safeJson(tc.function.arguments),
  }));

  const message: ChatMessage = {
    id: uid(),
    role: "assistant",
    content: choice.content ?? "",
    createdAt: Date.now(),
    ...(toolCalls?.length ? { toolCalls } : {}),
  };
  return { message };
}

async function callMessagesCompatible(
  opts: RunOptions,
): Promise<LlmCallResult> {
  const aMessages: unknown[] = [];
  for (const m of opts.messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      aMessages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const parts: unknown[] = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls)
        parts.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args ?? {},
        });
      aMessages.push({ role: "assistant", content: parts });
    } else if (m.role === "user" || m.role === "assistant") {
      aMessages.push({ role: m.role, content: m.content });
    }
  }

  const body: Record<string, unknown> = {
    model: opts.provider.model,
    messages: aMessages,
    max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
  };
  if (opts.systemPrompt) body.system = opts.systemPrompt;
  if (opts.tools.length) body.tools = buildToolDefs(opts.tools, "anthropic");

  const res = await fetchWithRetry(
    `${trimSlash(opts.provider.baseUrl)}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.provider.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        ...(opts.provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
  );

  if (!res.ok) throw new Error(`LLM ${res.status}: ${await res.text()}`);
  const json = await res.json();

  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of json.content ?? []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use")
      toolCalls.push({ id: block.id, name: block.name, args: block.input });
  }

  const message: ChatMessage = {
    id: uid(),
    role: "assistant",
    content: text,
    createdAt: Date.now(),
    ...(toolCalls.length ? { toolCalls } : {}),
  };
  return { message };
}

function trimSlash(u: string) {
  return u.replace(/\/+$/, "");
}

// ---------------- Token-aware history compaction ----------------

function approxBytes(m: ChatMessage): number {
  let size = m.content.length + 32;
  if (m.toolCalls) {
    for (const tc of m.toolCalls) {
      size +=
        (tc.id?.length ?? 0) +
        tc.name.length +
        JSON.stringify(tc.args ?? {}).length +
        32;
    }
  }
  return size;
}

function estimateToolDefsBytes(tools: McpTool[]): number {
  let total = 0;
  for (const t of tools) {
    total +=
      t.name.length +
      (t.description?.length ?? 0) +
      JSON.stringify(t.inputSchema ?? {}).length +
      48;
  }
  return total;
}

interface CompactResult extends CompactInfo {
  messages: ChatMessage[];
}

function compactMessages(
  messages: ChatMessage[],
  baselineBytes: number,
  budgetTokens: number,
): CompactResult {
  const budgetBytes = budgetTokens * CHARS_PER_TOKEN - baselineBytes;
  let totalBytes = 0;
  for (const m of messages) totalBytes += approxBytes(m);
  const origBytes = totalBytes;

  const toTokens = (b: number) => Math.ceil(b / CHARS_PER_TOKEN);

  if (totalBytes <= budgetBytes) {
    return {
      messages,
      origTokens: toTokens(origBytes + baselineBytes),
      finalTokens: toTokens(origBytes + baselineBytes),
      elided: 0,
    };
  }

  // Protect everything from the most recent user turn onwards.
  let protectFrom = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") {
      protectFrom = i;
      break;
    }
  }

  // Find elidable tool results (older than current turn, not already elided,
  // and large enough to be worth the marker overhead).
  const candidates: { idx: number; size: number }[] = [];
  for (let i = 0; i < protectFrom; i++) {
    const m = messages[i];
    if (!m) continue;
    if (
      m.role !== "tool" ||
      m.content.length < ELIDABLE_MIN_BYTES ||
      m.content.startsWith(ELIDED_PREFIX)
    )
      continue;
    candidates.push({ idx: i, size: m.content.length });
  }
  candidates.sort((a, b) => b.size - a.size);

  const out = messages.slice();
  let elided = 0;
  for (const c of candidates) {
    if (totalBytes <= budgetBytes) break;
    const orig = out[c.idx];
    if (!orig) continue;
    const toolBare = orig.toolName ?? "tool";
    const marker =
      `${ELIDED_PREFIX} from ${toolBare}: ${orig.content.length} chars omitted ` +
      `to fit context. Re-call the tool if you need this data.]`;
    totalBytes -= orig.content.length - marker.length;
    out[c.idx] = { ...orig, content: marker };
    elided++;
  }

  return {
    messages: out,
    origTokens: toTokens(origBytes + baselineBytes),
    finalTokens: toTokens(totalBytes + baselineBytes),
    elided,
  };
}

// Auto-retry once on 429. Honors Retry-After header (seconds or HTTP date),
// falls back to parsing "try again in N.NNs" from common provider bodies,
// then a 5s default. Caps wait at 30s to avoid silently hanging the UI.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  throwIfAborted(init.signal);
  const res = await fetchAfterForeground(url, init);
  if (res.status !== 429) return res;

  const body = await res.clone().text();
  let waitMs = parseRetryAfter(res.headers.get("retry-after")) ??
    parseRetryFromBody(body) ??
    5000;
  waitMs = Math.min(waitMs, 30_000);

  await abortableDelay(waitMs, init.signal);
  return fetchAfterForeground(url, init);
}

async function fetchAfterForeground(
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (res.status >= 500 && isBackgrounded()) {
      await waitForForeground(init.signal);
      return fetch(url, init);
    }
    return res;
  } catch (e) {
    if (isBackgrounded() && !init.signal?.aborted) {
      await waitForForeground(init.signal);
      return fetch(url, init);
    }
    throw e;
  }
}

function isBackgrounded(): boolean {
  return (
    typeof document !== "undefined" &&
    document.visibilityState === "hidden"
  );
}

function waitForForeground(signal?: AbortSignal | null): Promise<void> {
  throwIfAborted(signal);
  if (!isBackgrounded()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal?.removeEventListener("abort", onAbort);
    };
    const onVisibilityChange = () => {
      if (isBackgrounded()) return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function abortableDelay(
  waitMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n)) return n * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function parseRetryFromBody(body: string): number | null {
  const m = body.match(/try again in ([\d.]+)s/i);
  const seconds = m?.[1];
  return seconds ? Math.ceil(parseFloat(seconds) * 1000) : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
