import { Files } from "./db";
import type { McpTool, StoredFile } from "./types";

// Built-in tools backed by local IndexedDB storage. They are surfaced to the
// LLM through the same McpTool shape used by remote MCP servers, so the chat
// runner can treat local and remote tools identically.
export const LOCAL_SERVER_ID = "local";
const LOCAL_SERVER_NAME = "Local Files";

type Args = Record<string, unknown>;

interface LocalTool {
  name: string;
  description: string;
  inputSchema: object;
  handler: (args: Args) => Promise<string>;
}

// ---- argument coercion --------------------------------------------------

function requireString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`"${key}" must be a non-empty string`);
  return v;
}

function optionalString(args: Args, key: string): string {
  const v = args[key] ?? "";
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

// ---- shared schema fragments (declared once, reused per tool) ------------

const NAME_PROP = {
  name: { type: "string", description: "Unique file name (the key)." },
} as const;
const CONTENT_PROP = {
  content: { type: "string", description: "File contents." },
} as const;

function schema(properties: object, required: string[]): object {
  return { type: "object", properties, required };
}

function summarize(f: StoredFile): string {
  return `${f.name} (${f.content.length} chars)`;
}

// ---- file lookups -------------------------------------------------------

async function load(name: string): Promise<StoredFile> {
  const f = await Files.get(name);
  if (!f) throw new Error(`File "${name}" not found`);
  return f;
}

// ---- tool registry ------------------------------------------------------

const TOOLS: LocalTool[] = [
  {
    name: "create_file",
    description:
      "Create a new local file. Fails if a file with the same name already exists.",
    inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name"]),
    async handler(args) {
      const name = requireString(args, "name");
      const content = optionalString(args, "content");
      if (await Files.get(name))
        throw new Error(`File "${name}" already exists`);
      const now = Date.now();
      await Files.put({ name, content, createdAt: now, updatedAt: now });
      return `Created ${name} (${content.length} chars).`;
    },
  },
  {
    name: "read_file",
    description: "Read the full contents of a local file by name.",
    inputSchema: schema({ ...NAME_PROP }, ["name"]),
    async handler(args) {
      const file = await load(requireString(args, "name"));
      return file.content;
    },
  },
  {
    name: "update_file",
    description:
      "Replace the contents of an existing local file. Fails if it does not exist.",
    inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name", "content"]),
    async handler(args) {
      const name = requireString(args, "name");
      const content = optionalString(args, "content");
      const file = await load(name);
      await Files.put({ ...file, content, updatedAt: Date.now() });
      return `Updated ${name} (${content.length} chars).`;
    },
  },
  {
    name: "delete_file",
    description: "Delete a local file by name. Fails if it does not exist.",
    inputSchema: schema({ ...NAME_PROP }, ["name"]),
    async handler(args) {
      const name = requireString(args, "name");
      await load(name);
      await Files.remove(name);
      return `Deleted ${name}.`;
    },
  },
  {
    name: "list_files",
    description: "List all local files with their sizes.",
    inputSchema: schema({}, []),
    async handler() {
      const files = await Files.list();
      if (!files.length) return "No files.";
      return files
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(summarize)
        .join("\n");
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const localTools: McpTool[] = TOOLS.map((t) => ({
  serverId: LOCAL_SERVER_ID,
  serverName: LOCAL_SERVER_NAME,
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));

export async function callLocalTool(
  name: string,
  args: unknown,
): Promise<string> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown local tool "${name}"`);
  return tool.handler((args as Args) ?? {});
}
