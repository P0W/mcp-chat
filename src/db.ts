import { openDB, type IDBPDatabase } from "idb";
import type {
  Chat,
  McpServerConfig,
  ProviderConfig,
  StoredFile,
} from "./types";

const DB_NAME = "mcp-chat";
const DB_VERSION = 2;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains("providers"))
          db.createObjectStore("providers", { keyPath: "id" });
        if (!db.objectStoreNames.contains("mcps"))
          db.createObjectStore("mcps", { keyPath: "id" });
        if (!db.objectStoreNames.contains("chats"))
          db.createObjectStore("chats", { keyPath: "id" });
        if (!db.objectStoreNames.contains("files"))
          db.createObjectStore("files", { keyPath: "name" });
        if (!db.objectStoreNames.contains("meta"))
          db.createObjectStore("meta");
      },
    });
  }
  return dbPromise;
}

// Generic CRUD over an in-line-keyed object store. The store's keyPath is
// declared once at creation (above); records carry their own key, so callers
// never pass it explicitly on writes.
export interface CrudStore<T> {
  list(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

function crudStore<T>(store: string): CrudStore<T> {
  return {
    async list() {
      return (await db()).getAll(store) as Promise<T[]>;
    },
    async get(key) {
      return (await db()).get(store, key) as Promise<T | undefined>;
    },
    async put(value) {
      await (await db()).put(store, value as object);
    },
    async remove(key) {
      await (await db()).delete(store, key);
    },
  };
}

export const Providers = crudStore<ProviderConfig>("providers");
export const Mcps = crudStore<McpServerConfig>("mcps");
export const Files = crudStore<StoredFile>("files");

export const Chats: CrudStore<Chat> = {
  ...crudStore<Chat>("chats"),
  async list() {
    const all = (await (await db()).getAll("chats")) as Chat[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
};

export const Meta = {
  async get<T>(key: string): Promise<T | undefined> {
    return (await db()).get("meta", key);
  },
  async set<T>(key: string, value: T) {
    await (await db()).put("meta", value as unknown as object, key);
  },
};

export function uid(): string {
  return crypto.randomUUID();
}
