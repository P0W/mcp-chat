import { openDB, type IDBPDatabase } from "idb";
import type { Chat, McpServerConfig, ProviderConfig } from "./types";

const DB_NAME = "mcp-chat";
const DB_VERSION = 1;

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
        if (!db.objectStoreNames.contains("meta"))
          db.createObjectStore("meta");
      },
    });
  }
  return dbPromise;
}

export const Providers = {
  async list(): Promise<ProviderConfig[]> {
    return (await db()).getAll("providers");
  },
  async get(id: string): Promise<ProviderConfig | undefined> {
    return (await db()).get("providers", id);
  },
  async put(p: ProviderConfig) {
    await (await db()).put("providers", p);
  },
  async remove(id: string) {
    await (await db()).delete("providers", id);
  },
};

export const Mcps = {
  async list(): Promise<McpServerConfig[]> {
    return (await db()).getAll("mcps");
  },
  async get(id: string): Promise<McpServerConfig | undefined> {
    return (await db()).get("mcps", id);
  },
  async put(m: McpServerConfig) {
    await (await db()).put("mcps", m);
  },
  async remove(id: string) {
    await (await db()).delete("mcps", id);
  },
};

export const Chats = {
  async list(): Promise<Chat[]> {
    const all = (await (await db()).getAll("chats")) as Chat[];
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async get(id: string): Promise<Chat | undefined> {
    return (await db()).get("chats", id);
  },
  async put(c: Chat) {
    await (await db()).put("chats", c);
  },
  async remove(id: string) {
    await (await db()).delete("chats", id);
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
