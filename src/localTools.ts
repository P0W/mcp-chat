import {
  Directory,
  Encoding,
  Filesystem,
  type FileInfo,
  type StatResult,
} from "@capacitor/filesystem";
import { createToolRegistry, type ToolDef } from "./toolRegistry";

export const LOCAL_SERVER_ID = "local";
const LOCAL_SERVER_NAME = "Local Files";
const ROOT_DIR = "MCP Chat";
const DEFAULT_WORKING_DIR = "workspace";

type Args = Record<string, unknown>;

// ---- argument coercion --------------------------------------------------

function nonEmptyString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.trim().length === 0)
    throw new Error(`"${key}" must be a non-empty string`);
  return v;
}

// Required key that may legitimately be an empty string (e.g. an empty file).
function definedString(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function optionalString(args: Args, key: string): string {
  const v = args[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Error(`"${key}" must be a string`);
  return v;
}

function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  return absolute ? `/${joined}` : joined || ".";
}

function ensureInsideRoot(path: string): string {
  const rel = path.startsWith("/") ? path.slice(1) : path;
  const segments = rel.split("/");
  if (
    rel.length === 0 ||
    rel === "." ||
    rel === ".." ||
    rel.startsWith("../") ||
    segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")
  ) {
    throw new Error("Path must point inside storage root");
  }
  return rel;
}

function resolvePath(name: string): string {
  const normalized = normalizePath(
    name.startsWith("/") ? name : `${DEFAULT_WORKING_DIR}/${name}`,
  );
  return ensureInsideRoot(normalized);
}

function resolveDir(path?: string): string {
  if (!path) return DEFAULT_WORKING_DIR;
  const normalized = normalizePath(
    path.startsWith("/") ? path : `${DEFAULT_WORKING_DIR}/${path}`,
  );
  return ensureInsideRoot(normalized);
}

function storagePath(relPath: string): string {
  return `${ROOT_DIR}/${relPath}`;
}

function asDisplayPath(relPath: string): string {
  return `/${relPath}`;
}

function isNotFoundError(error: unknown): boolean {
  const msg = (error as Error)?.message?.toLowerCase?.() ?? "";
  return (
    msg.includes("not found") ||
    msg.includes("does not exist") ||
    msg.includes("no such file")
  );
}

/** Return file stat if present; return null for missing files, rethrow otherwise. */
async function getFileStatOrNull(relPath: string): Promise<StatResult | null> {
  try {
    return await Filesystem.stat({
      path: storagePath(relPath),
      directory: Directory.Documents,
    });
  } catch (e) {
    if (isNotFoundError(e)) return null;
    throw e;
  }
}

/** Join two POSIX path parts while handling an empty base path. */
function joinPath(base: string, name: string): string {
  return base.length ? `${base}/${name}` : name;
}

function summarize(path: string, f: FileInfo): string {
  return `${asDisplayPath(path)} (${f.size} bytes)`;
}

/** Recursively list files (not directories) under the given directory path. */
async function listFilesRecursive(dirRelPath: string): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  const stack: string[] = [dirRelPath];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: FileInfo[];
    try {
      entries = (
        await Filesystem.readdir({
          path: storagePath(current),
          directory: Directory.Documents,
        })
      ).files;
    } catch (e) {
      if (isNotFoundError(e) && current === dirRelPath) return [];
      if (isNotFoundError(e)) continue;
      throw e;
    }
    for (const item of entries) {
      const rel = joinPath(current, item.name);
      if (item.type === "directory") stack.push(rel);
      else out.push({ ...item, name: rel });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read a UTF-8 file, normalizing native/web plugin return types to string. */
async function readUtf8File(relPath: string): Promise<string> {
  const data = (
    await Filesystem.readFile({
      path: storagePath(relPath),
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    })
  ).data;
  if (typeof data === "string") return data;
  if (data instanceof Blob) return await data.text();
  throw new Error("Unexpected file payload type");
}

const NAME_PROP = {
  name: {
    type: "string",
    description:
      "File path. Relative paths resolve under /workspace; absolute paths " +
      "(starting with '/') are resolved under / in app Documents storage.",
  },
} as const;
const CONTENT_PROP = {
  content: { type: "string", description: "File contents." },
} as const;
const PATH_PROP = {
  path: {
    type: "string",
    description:
      "Directory to list. Defaults to /workspace. Relative paths resolve " +
      "under /workspace.",
  },
} as const;

function schema(properties: object, required: string[]): object {
  return { type: "object", properties, required };
}

export function createFileTools(): ToolDef[] {
  return [
    {
      name: "create_file",
      description:
        "Create a new file in phone Documents storage. Fails if file exists.",
      inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(nonEmptyString(args, "name"));
        const content = optionalString(args, "content");
        if (await getFileStatOrNull(path))
          throw new Error(`File "${asDisplayPath(path)}" already exists`);
        await Filesystem.writeFile({
          path: storagePath(path),
          directory: Directory.Documents,
          data: content,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        return `Created ${asDisplayPath(path)} (${content.length} chars) in /Documents/${ROOT_DIR}.`;
      },
    },
    {
      name: "read_file",
      description: "Read the full contents of a file from phone Documents storage.",
      inputSchema: schema({ ...NAME_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(nonEmptyString(args, "name"));
        if (!(await getFileStatOrNull(path)))
          throw new Error(`File "${asDisplayPath(path)}" not found`);
        return readUtf8File(path);
      },
    },
    {
      name: "update_file",
      description:
        "Replace contents of an existing file in phone Documents storage.",
      inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name", "content"]),
      async handler(args) {
        const path = resolvePath(nonEmptyString(args, "name"));
        const content = definedString(args, "content");
        if (!(await getFileStatOrNull(path)))
          throw new Error(`File "${asDisplayPath(path)}" not found`);
        await Filesystem.writeFile({
          path: storagePath(path),
          directory: Directory.Documents,
          data: content,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        return `Updated ${asDisplayPath(path)} (${content.length} chars) in /Documents/${ROOT_DIR}.`;
      },
    },
    {
      name: "delete_file",
      description: "Delete a file from phone Documents storage by path.",
      inputSchema: schema({ ...NAME_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(nonEmptyString(args, "name"));
        if (!(await getFileStatOrNull(path)))
          throw new Error(`File "${asDisplayPath(path)}" not found`);
        await Filesystem.deleteFile({
          path: storagePath(path),
          directory: Directory.Documents,
        });
        return `Deleted ${asDisplayPath(path)}.`;
      },
    },
    {
      name: "list_files",
      description:
        "List files under a directory in phone Documents storage, with sizes.",
      inputSchema: schema({ ...PATH_PROP }, []),
      async handler(args) {
        const raw = optionalString(args, "path");
        const dir = resolveDir(raw || undefined);
        const files = await listFilesRecursive(dir);
        if (!files.length) return `No files in ${dir}.`;
        return files.map((f) => summarize(f.name, f)).join("\n");
      },
    },
  ];
}

const registry = createToolRegistry(
  LOCAL_SERVER_ID,
  LOCAL_SERVER_NAME,
  createFileTools(),
);

export const localTools = registry.tools;
export const callLocalTool = registry.call;
