import type { ChatMessage, McpTool, ProviderConfig, ToolCall } from "./types";

export interface ToolRunner {
  call(serverId: string, toolName: string, args: unknown): Promise<string>;
}

export interface RunOptions {
  provider: ProviderConfig;
  systemPrompt?: string;
  messages: ChatMessage[];
  tools: McpTool[];
  runner: ToolRunner;
  onAssistant: (msg: ChatMessage) => void;
  onToolResult: (msg: ChatMessage) => void;
  maxIterations?: number;
  signal?: AbortSignal;
}

const TOOL_NAME_RE = /[^a-zA-Z0-9_-]/g;

function toolKey(t: McpTool): string {
  const safe = `${t.serverName}__${t.name}`.replace(TOOL_NAME_RE, "_");
  return safe.slice(0, 64);
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
  for (let i = 0; i < max; i++) {
    const result =
      opts.provider.protocol === "anthropic"
        ? await callAnthropic(opts)
        : await callOpenAI(opts);

    opts.onAssistant(result.message);
    opts.messages.push(result.message);

    if (!result.message.toolCalls || result.message.toolCalls.length === 0)
      return;

    for (const tc of result.message.toolCalls) {
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
          );
        } catch (e) {
          content = `Error: ${(e as Error).message}`;
        }
      }
      const toolMsg: ChatMessage = {
        id: uid(),
        role: "tool",
        content,
        toolCallId: tc.id,
        toolName: tc.name,
        createdAt: Date.now(),
      };
      opts.onToolResult(toolMsg);
      opts.messages.push(toolMsg);
    }
  }
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

async function callOpenAI(opts: RunOptions): Promise<{ message: ChatMessage }> {
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
  };
  if (opts.tools.length)
    body.tools = buildToolDefs(opts.tools, "openai");

  const res = await fetchWithRetry(
    `${trimSlash(opts.provider.baseUrl)}/chat/completions`,
    {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.provider.apiKey}`,
        ...(opts.provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
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

  return {
    message: {
      id: uid(),
      role: "assistant",
      content: choice.content ?? "",
      toolCalls,
      createdAt: Date.now(),
    },
  };
}

async function callAnthropic(
  opts: RunOptions,
): Promise<{ message: ChatMessage }> {
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
    max_tokens: 4096,
  };
  if (opts.systemPrompt) body.system = opts.systemPrompt;
  if (opts.tools.length) body.tools = buildToolDefs(opts.tools, "anthropic");

  const res = await fetchWithRetry(
    `${trimSlash(opts.provider.baseUrl)}/messages`,
    {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": opts.provider.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        ...(opts.provider.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
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

  return {
    message: {
      id: uid(),
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      createdAt: Date.now(),
    },
  };
}

function trimSlash(u: string) {
  return u.replace(/\/+$/, "");
}

// Auto-retry once on 429. Honors Retry-After header (seconds or HTTP date),
// falls back to parsing "try again in N.NNs" from common provider bodies,
// then a 5s default. Caps wait at 30s to avoid silently hanging the UI.
async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const res = await fetch(url, init);
  if (res.status !== 429) return res;

  const body = await res.clone().text();
  let waitMs = parseRetryAfter(res.headers.get("retry-after")) ??
    parseRetryFromBody(body) ??
    5000;
  waitMs = Math.min(waitMs, 30_000);

  await new Promise((r) => setTimeout(r, waitMs));
  return fetch(url, init);
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
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
