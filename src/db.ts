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
// never pass it explicitly on writes. `add`, `update` and `remove` run inside
// a single transaction each, so check-and-write is atomic (no lost updates).
export interface CrudStore<T> {
  list(): Promise<T[]>;
  get(key: string): Promise<T | undefined>;
  put(value: T): Promise<void>;
  /** Insert a new record; rejects (ConstraintError) if the key already exists. */
  add(value: T): Promise<void>;
  /** Atomically read-modify-write; returns false (no write) if key is absent. */
  update(key: string, mutator: (current: T) => T): Promise<boolean>;
  /** Atomically delete; returns whether a record actually existed. */
  remove(key: string): Promise<boolean>;
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
    async add(value) {
      await (await db()).add(store, value as object);
    },
    async update(key, mutator) {
      const tx = (await db()).transaction(store, "readwrite");
      const current = (await tx.store.get(key)) as T | undefined;
      if (current !== undefined) await tx.store.put(mutator(current) as object);
      await tx.done;
      return current !== undefined;
    },
    async remove(key) {
      const tx = (await db()).transaction(store, "readwrite");
      const existed = (await tx.store.get(key)) !== undefined;
      if (existed) await tx.store.delete(key);
      await tx.done;
      return existed;
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
