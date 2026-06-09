import type { McpTool } from "./types";

// Generic, project-agnostic tool registry. It turns a set of named handlers
// into the `McpTool` shape the chat runner consumes, plus a `call` dispatcher.
// It knows nothing about files, storage, or any specific domain — supply your
// own `ToolDef[]` to expose any local capability to the LLM.

export type ToolHandler = (args: Record<string, unknown>) => Promise<string>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: ToolHandler;
}

export interface ToolRegistry {
  /** Tool descriptors to advertise to the model. */
  readonly tools: McpTool[];
  /** Dispatch a tool call by name; throws if the tool is unknown. */
  call(name: string, args: unknown): Promise<string>;
}

export function createToolRegistry(
  serverId: string,
  serverName: string,
  defs: ToolDef[],
): ToolRegistry {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const tools: McpTool[] = defs.map((d) => ({
    serverId,
    serverName,
    name: d.name,
    description: d.description,
    inputSchema: d.inputSchema,
  }));

  return {
    tools,
    async call(name, args) {
      const def = byName.get(name);
      if (!def) throw new Error(`Unknown tool "${name}"`);
      return def.handler((args as Record<string, unknown>) ?? {});
    },
  };
}
