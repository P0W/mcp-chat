import { afterEach, describe, expect, it, vi } from "vitest";
import { runChat } from "./llm";
import type { ChatMessage, ProviderConfig } from "./types";

function provider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "p",
    name: "p",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "test",
    model: "gpt-4o-mini",
    ...overrides,
  };
}

function captureFetch(response: unknown) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return new Response(JSON.stringify(response), { status: 200 });
    }),
  );
  return bodies;
}

const OPENAI_REPLY = { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
const ANTHROPIC_REPLY = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };

function userMessage(extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id: "u", role: "user", content: "Describe", createdAt: 0, ...extra };
}

const image = {
  id: "a",
  name: "cat.png",
  format: "png" as const,
  kind: "image" as const,
  mimeType: "image/png",
  size: 3,
  data: "AAAA",
};

async function run(p: ProviderConfig, messages: ChatMessage[]) {
  await runChat({
    provider: p,
    messages,
    tools: [],
    runner: { call: async () => "" },
    onAssistant: () => {},
    onToolResult: () => {},
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runChat attachment serialization", () => {
  it("keeps text-only user messages as plain strings (OpenAI)", async () => {
    const bodies = captureFetch(OPENAI_REPLY);
    await run(provider({}), [userMessage()]);
    expect(bodies[0]!.messages).toEqual([{ role: "user", content: "Describe" }]);
  });

  it("sends images as image_url parts to vision models (OpenAI)", async () => {
    const bodies = captureFetch(OPENAI_REPLY);
    await run(provider({}), [userMessage({ attachments: [image] })]);
    const [msg] = bodies[0]!.messages as { content: unknown }[];
    expect(msg!.content).toEqual([
      { type: "text", text: "[Attached image: cat.png]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      { type: "text", text: "Describe" },
    ]);
  });

  it("degrades to a text note for text-only providers", async () => {
    const bodies = captureFetch(OPENAI_REPLY);
    await run(provider({ baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" }), [
      userMessage({ attachments: [image] }),
    ]);
    const [msg] = bodies[0]!.messages as { content: unknown }[];
    expect(typeof msg!.content).toBe("string");
    expect(msg!.content).toMatch(/not included: the selected provider\/model doesn't accept image input/);
    expect(msg!.content).toMatch(/Describe$/);
  });

  it("sends image blocks and allows attachment-only messages (Anthropic)", async () => {
    const bodies = captureFetch(ANTHROPIC_REPLY);
    await run(
      provider({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" }),
      [userMessage({ content: "", attachments: [image] })],
    );
    expect(bodies[0]!.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "[Attached image: cat.png]" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("keeps text-only Anthropic messages unchanged", async () => {
    const bodies = captureFetch(ANTHROPIC_REPLY);
    await run(
      provider({ protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-6" }),
      [userMessage()],
    );
    expect(bodies[0]!.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Describe" }] },
    ]);
  });
});
