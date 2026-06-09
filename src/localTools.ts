import { Files, Meta, type CrudStore } from "./db";
import type { StoredFile } from "./types";
import { createToolRegistry, type ToolDef } from "./toolRegistry";

// Built-in file CRUD backed by local storage, surfaced to the LLM through the
// generic tool registry. Handlers depend only on the injected `FileToolsDeps`,
// so this factory is reusable with any backend that satisfies the interfaces
// (IndexedDB here, but equally an in-memory map or a remote API elsewhere).

export const LOCAL_SERVER_ID = "local";
const LOCAL_SERVER_NAME = "Local Files";

// App files live under a working directory by default. It is created lazily —
// only the first file operation persists it — and callers may still reach
// other locations via absolute paths.
const WORKING_DIR_KEY = "workingDir";
const DEFAULT_WORKING_DIR = "/workspace";

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

// ---- path handling ------------------------------------------------------

// POSIX-style normalization: collapses duplicate slashes, resolves "." and
// ".." segments, and never lets ".." escape above root. Returns "/" for an
// empty absolute path and "." for an empty relative one.
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

// Relative names resolve under the working directory; absolute names (starting
// with "/") are honored as-is, so the model can reach other locations.
function resolvePath(workingDir: string, name: string): string {
  return normalizePath(name.startsWith("/") ? name : `${workingDir}/${name}`);
}

// ---- schema fragments (declared once, reused per tool) ------------------

const NAME_PROP = {
  name: {
    type: "string",
    description:
      "File path. Relative paths resolve under the working directory; " +
      "absolute paths (starting with '/') are used as-is.",
  },
} as const;
const CONTENT_PROP = {
  content: { type: "string", description: "File contents." },
} as const;
const PATH_PROP = {
  path: {
    type: "string",
    description:
      "Directory to list; defaults to the working directory. Relative " +
      "paths resolve under the working directory.",
  },
} as const;

function schema(properties: object, required: string[]): object {
  return { type: "object", properties, required };
}

function summarize(f: StoredFile): string {
  return `${f.name} (${f.content.length} chars)`;
}

// ---- dependencies (injected for reuse) ----------------------------------

export interface FileToolsDeps {
  store: CrudStore<StoredFile>;
  /** Lazily resolve (and persist on first use) the default working directory. */
  resolveWorkingDir: () => Promise<string>;
}

export function createFileTools(deps: FileToolsDeps): ToolDef[] {
  const { store, resolveWorkingDir } = deps;

  return [
    {
      name: "create_file",
      description:
        "Create a new local file. Fails if a file with the same path already exists.",
      inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(
          await resolveWorkingDir(),
          nonEmptyString(args, "name"),
        );
        const content = optionalString(args, "content");
        const now = Date.now();
        try {
          await store.add({ name: path, content, createdAt: now, updatedAt: now });
        } catch (e) {
          if (e instanceof DOMException && e.name === "ConstraintError")
            throw new Error(`File "${path}" already exists`);
          throw e;
        }
        return `Created ${path} (${content.length} chars).`;
      },
    },
    {
      name: "read_file",
      description: "Read the full contents of a local file by path.",
      inputSchema: schema({ ...NAME_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(
          await resolveWorkingDir(),
          nonEmptyString(args, "name"),
        );
        const file = await store.get(path);
        if (!file) throw new Error(`File "${path}" not found`);
        return file.content;
      },
    },
    {
      name: "update_file",
      description:
        "Replace the contents of an existing local file. Fails if it does not exist.",
      inputSchema: schema({ ...NAME_PROP, ...CONTENT_PROP }, ["name", "content"]),
      async handler(args) {
        const path = resolvePath(
          await resolveWorkingDir(),
          nonEmptyString(args, "name"),
        );
        const content = definedString(args, "content");
        const updated = await store.update(path, (f) => ({
          ...f,
          content,
          updatedAt: Date.now(),
        }));
        if (!updated) throw new Error(`File "${path}" not found`);
        return `Updated ${path} (${content.length} chars).`;
      },
    },
    {
      name: "delete_file",
      description: "Delete a local file by path. Fails if it does not exist.",
      inputSchema: schema({ ...NAME_PROP }, ["name"]),
      async handler(args) {
        const path = resolvePath(
          await resolveWorkingDir(),
          nonEmptyString(args, "name"),
        );
        if (!(await store.remove(path)))
          throw new Error(`File "${path}" not found`);
        return `Deleted ${path}.`;
      },
    },
    {
      name: "list_files",
      description:
        "List local files under a directory (the working directory by default), with sizes.",
      inputSchema: schema({ ...PATH_PROP }, []),
      async handler(args) {
        const workingDir = await resolveWorkingDir();
        const raw = optionalString(args, "path");
        const dir = raw ? resolvePath(workingDir, raw) : workingDir;
        const prefix = dir === "/" ? "/" : `${dir}/`;
        const files = (await store.list())
          .filter((f) => f.name === dir || f.name.startsWith(prefix))
          .sort((a, b) => a.name.localeCompare(b.name));
        if (!files.length) return `No files in ${dir}.`;
        return files.map(summarize).join("\n");
      },
    },
  ];
}

// ---- concrete instance wired to this app's IndexedDB stores --------------

async function resolveWorkingDir(): Promise<string> {
  const stored = await Meta.get<string>(WORKING_DIR_KEY);
  if (typeof stored === "string" && stored.length > 0) return stored;
  const dir = normalizePath(DEFAULT_WORKING_DIR);
  await Meta.set(WORKING_DIR_KEY, dir);
  return dir;
}

const registry = createToolRegistry(
  LOCAL_SERVER_ID,
  LOCAL_SERVER_NAME,
  createFileTools({ store: Files, resolveWorkingDir }),
);

export const localTools = registry.tools;
export const callLocalTool = registry.call;
