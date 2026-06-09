import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import { createToolRegistry, type ToolDef } from "./toolRegistry";

const SQL_SERVER_ID = "session-sqlite";
const SQL_SERVER_NAME = "Session SQLite";
const DEFAULT_DB = "default";
const MAX_IMPORT_BYTES = 2_000_000;
const MAX_IMPORT_ROWS = 20_000;
const MAX_DB_IMPORT_BYTES = 8_000_000;
const DEFAULT_MAX_ROWS = 200;
const MAX_RESULT_ROWS = 1_000;
const MAX_RESULT_CHARS = 60_000;

type Args = Record<string, unknown>;
type Cell = number | string | Uint8Array | null;
type ImportKind = "auto" | "csv" | "json" | "text" | "markdown";

interface QueryResult {
  columns: string[];
  values: Cell[][];
}

interface SqlDatabase {
  exec(sql: string, params?: Cell[] | Record<string, Cell> | null): QueryResult[];
  run(sql: string, params?: Cell[] | Record<string, Cell> | null): SqlDatabase;
  export(): Uint8Array;
  close(): void;
}

interface SqlJsStatic {
  Database: new (data?: ArrayLike<number> | null) => SqlDatabase;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;
const databases = new Map<string, SqlDatabase>();
const pendingDatabases = new Map<string, Promise<SqlDatabase>>();

function schema(properties: object, required: string[]): object {
  return { type: "object", properties, required };
}

function optionalString(args: Args, key: string, fallback = ""): string {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  return value;
}

function nonEmptyString(args: Args, key: string): string {
  const value = optionalString(args, key).trim();
  if (!value) throw new Error(`"${key}" must be a non-empty string`);
  return value;
}

function definedString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string") throw new Error(`"${key}" must be a string`);
  return value;
}

function optionalNumber(args: Args, key: string, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`"${key}" must be a finite number`);
  return value;
}

function dbName(args: Args): string {
  return optionalString(args, "db", DEFAULT_DB).trim() || DEFAULT_DB;
}

function normalizeLimit(args: Args): number {
  const limit = Math.trunc(optionalNumber(args, "max_rows", DEFAULT_MAX_ROWS));
  if (limit < 1) throw new Error('"max_rows" must be at least 1');
  return Math.min(limit, MAX_RESULT_ROWS);
}

function identifier(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed))
    throw new Error(
      "Table and column names must start with a letter or underscore and contain only letters, numbers, and underscores",
    );
  return quoteIdentifier(trimmed);
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function uniqueColumns(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name, idx) => {
    const base = sanitizeColumn(name) || `col_${idx + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count}`;
  });
}

function sanitizeColumn(name: string): string {
  return name
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^([0-9])/, "col_$1");
}

async function sqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = import("sql.js").then((mod) => {
      const init = (
        "default" in mod ? mod.default : mod
      ) as unknown as (config: { locateFile: () => string }) => Promise<SqlJsStatic>;
      return init({ locateFile: () => wasmUrl });
    });
  }
  return sqlJsPromise;
}

async function getDb(name: string): Promise<SqlDatabase> {
  const current = databases.get(name);
  if (current) return current;
  const pending = pendingDatabases.get(name);
  if (pending) return pending;
  const created = (async () => {
    const SQL = await sqlJs();
    const db = new SQL.Database();
    const existing = databases.get(name);
    if (existing) {
      db.close();
      return existing;
    }
    databases.set(name, db);
    return db;
  })();
  pendingDatabases.set(name, created);
  try {
    return await created;
  } finally {
    pendingDatabases.delete(name);
  }
}

function resultRows(result: QueryResult, maxRows: number): Record<string, Cell>[] {
  return result.values.slice(0, maxRows).map((row) => {
    const obj: Record<string, Cell> = {};
    result.columns.forEach((column, idx) => {
      obj[column] = row[idx] ?? null;
    });
    return obj;
  });
}

function serialize(value: unknown): string {
  const text = JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return { type: "blob", base64: bytesToBase64(item) };
    return item;
  });
  if (!text) return "";
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...[truncated ${text.length - MAX_RESULT_CHARS} chars]`;
}

function sqlParams(args: Args): Cell[] | Record<string, Cell> | null {
  const params = args.params;
  if (params === undefined || params === null) return null;
  if (Array.isArray(params)) return params.map(toSqlCell);
  if (typeof params === "object") {
    const out: Record<string, Cell> = {};
    for (const [key, value] of Object.entries(params))
      out[key] = toSqlCell(value);
    return out;
  }
  throw new Error('"params" must be an array or object');
}

function toSqlCell(value: unknown): Cell {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("SQL numbers must be finite");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  throw new Error("SQL values must be strings, numbers, booleans, or null");
}

function hasWrites(sql: string): boolean {
  return /\b(ALTER|CREATE|DELETE|DROP|INSERT|REINDEX|REPLACE|UPDATE|VACUUM)\b/i.test(
    stripSqlComments(sql),
  );
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function detectKind(data: string, requested: ImportKind): ImportKind {
  if (requested !== "auto") return requested;
  const trimmed = data.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  if (looksLikeMarkdownTable(data)) return "markdown";
  if (looksLikeCsv(data)) return "csv";
  return "text";
}

function looksLikeMarkdownTable(data: string): boolean {
  const lines = data.split(/\r?\n/).filter((line) => line.trim());
  const header = lines[0];
  const divider = lines[1];
  return Boolean(
    header?.includes("|") &&
      divider &&
      /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(divider),
  );
}

function looksLikeCsv(data: string): boolean {
  const lines = data.split(/\r?\n/).filter((line) => line.trim());
  const firstLine = lines[0];
  const secondLine = lines[1];
  if (firstLine === undefined || secondLine === undefined) return false;
  const first = parseCsvLine(firstLine);
  const second = parseCsvLine(secondLine);
  return first.length > 1 && second.length === first.length;
}

function parseCsv(data: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let column = 1;
  let quoteLine = 1;
  let quoteColumn = 1;
  for (let i = 0; i < data.length; i++) {
    const ch = data.charAt(i);
    const next = data[i + 1];
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"';
        i++;
        column++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
      quoteLine = line;
      quoteColumn = column;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
    if (ch === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  if (quoted)
    throw new Error(
      `CSV contains an unterminated quoted field starting at line ${quoteLine}, column ${quoteColumn}`,
    );
  if (cell.length || row.length) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim().length > 0));
}

function parseCsvLine(line: string): string[] {
  return parseCsv(`${line}\n`)[0] ?? [];
}

function parseMarkdownTable(data: string): string[][] {
  const rows = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes("|"));
  if (rows.length < 2) return [];
  const out = rows
    .filter((_line, idx) => idx !== 1)
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim()),
    );
  return out;
}

function parseJsonRows(data: string): { columns: string[]; rows: Cell[][] } {
  const parsed = JSON.parse(data) as unknown;
  const source = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? Object.entries(parsed).map(([key, value]) => ({ key, value }))
      : [{ value: parsed }];
  if (!source.length) return { columns: ["value"], rows: [] };
  if (source.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    const columns = uniqueColumns([
      ...new Set(source.flatMap((item) => Object.keys(item as Record<string, unknown>))),
    ]);
    const originalColumns = [
      ...new Set(source.flatMap((item) => Object.keys(item as Record<string, unknown>))),
    ];
    return {
      columns,
      rows: source.map((item) =>
        originalColumns.map((column) =>
          jsonToCell((item as Record<string, unknown>)[column]),
        ),
      ),
    };
  }
  return {
    columns: ["value"],
    rows: source.map((item) => [jsonToCell(item)]),
  };
}

function jsonToCell(value: unknown): Cell {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function parseRows(data: string, kind: ImportKind): { columns: string[]; rows: Cell[][] } {
  if (kind === "json") return parseJsonRows(data);
  if (kind === "text") {
    if (data.length === 0) return { columns: ["line_number", "content"], rows: [] };
    return {
      columns: ["line_number", "content"],
      rows: data.split(/\r?\n/).map((line, idx) => [idx + 1, line]),
    };
  }
  const table = kind === "markdown" ? parseMarkdownTable(data) : parseCsv(data);
  if (!table.length) return { columns: ["value"], rows: [] };
  const width = Math.max(...table.map((row) => row.length));
  const [header] = table;
  const columns = uniqueColumns(
    Array.from({ length: width }, (_value, idx) => header?.[idx] ?? `col_${idx + 1}`),
  );
  return {
    columns,
    rows: table.slice(1).map((row) =>
      Array.from({ length: width }, (_value, idx) => row[idx] ?? null),
    ),
  };
}

function importRows(
  db: SqlDatabase,
  tableName: string,
  columns: string[],
  rows: Cell[][],
  replace: boolean,
): void {
  const table = identifier(tableName);
  const quotedColumns = columns.map(identifier);
  db.run("BEGIN");
  try {
    if (replace) db.run(`DROP TABLE IF EXISTS ${table}`);
    db.run(
      `CREATE TABLE IF NOT EXISTS ${table} (${quotedColumns
        .map((col, idx) => `${col} ${columnType(rows, idx)}`)
        .join(", ")})`,
    );
    if (rows.length) {
      const placeholders = columns.map(() => "?").join(", ");
      const sql = `INSERT INTO ${table} (${quotedColumns.join(", ")}) VALUES (${placeholders})`;
      rows.forEach((row) => db.run(sql, row));
    }

    function columnType(rows: Cell[][], column: number): "BLOB" | "INTEGER" | "REAL" | "TEXT" {
      let numeric = false;
      let real = false;
      let blob = false;
      for (const row of rows) {
        const value = row[column];
        if (value === null || value === undefined) continue;
        if (typeof value === "number") {
          numeric = true;
          if (!Number.isInteger(value)) real = true;
        } else if (value instanceof Uint8Array) {
          blob = true;
        } else {
          return "TEXT";
        }
      }
      if (blob) return numeric ? "TEXT" : "BLOB";
      if (real) return "REAL";
      return numeric ? "INTEGER" : "TEXT";
    }
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, "");
  const decodedLength = Math.floor((compact.length * 3) / 4) -
    (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0);
  if (decodedLength > MAX_DB_IMPORT_BYTES)
    throw new Error(`Database import exceeds ${MAX_DB_IMPORT_BYTES} bytes`);
  const binary = atob(compact);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function createSessionSqlTools(): ToolDef[] {
  return [
    {
      name: "sql_exec",
      description:
        "Execute SQLite SQL against an optional session-scoped in-memory database. Supports CREATE/ALTER/DROP, INSERT/UPDATE/DELETE, SELECT, JOIN, GROUP BY, ORDER BY, and parameters.",
      inputSchema: schema(
        {
          db: { type: "string", description: "Session database name. Defaults to default." },
          sql: { type: "string", description: "SQL statement(s) to execute." },
          params: {
            description: "Optional SQLite bind parameters as an array or object.",
          },
          max_rows: {
            type: "number",
            description: `Maximum rows returned per result set, capped at ${MAX_RESULT_ROWS}.`,
          },
        },
        ["sql"],
      ),
      async handler(args) {
        const name = dbName(args);
        const sql = nonEmptyString(args, "sql");
        const db = await getDb(name);
        const before = db.exec("SELECT total_changes() AS changes")[0]?.values[0]?.[0] ?? 0;
        const results = db.exec(sql, sqlParams(args));
        const after = db.exec("SELECT total_changes() AS changes")[0]?.values[0]?.[0] ?? before;
        const maxRows = normalizeLimit(args);
        return serialize({
          db: name,
          changed_database: hasWrites(sql),
          rows_modified: Number(after) - Number(before),
          result_sets: results.map((result) => ({
            columns: result.columns,
            rows: resultRows(result, maxRows),
            returned_rows: Math.min(result.values.length, maxRows),
            total_rows: result.values.length,
            truncated: result.values.length > maxRows,
          })),
        });
      },
    },
    {
      name: "sql_import_data",
      description:
        "Import MCP output or local file contents into a SQLite table. Handles JSON, CSV, markdown tables, and plain text/markdown lines.",
      inputSchema: schema(
        {
          db: { type: "string", description: "Session database name. Defaults to default." },
          table: { type: "string", description: "Destination table name." },
          data: {
            type: "string",
            description:
              "Raw data from an MCP result or from read_file for markdown, CSV, text, or JSON files.",
          },
          kind: {
            type: "string",
            enum: ["auto", "csv", "json", "text", "markdown"],
            description: "Input format. Defaults to auto.",
          },
          replace: {
            type: "boolean",
            description:
              "Drop and recreate the table first. Defaults to false; set true to overwrite existing data.",
          },
        },
        ["table", "data"],
      ),
      async handler(args) {
        const name = dbName(args);
        const table = nonEmptyString(args, "table");
        const data = definedString(args, "data");
        if (data.length > MAX_IMPORT_BYTES)
          throw new Error(`Import data exceeds ${MAX_IMPORT_BYTES} characters`);
        const requested = optionalString(args, "kind", "auto") as ImportKind;
        if (!["auto", "csv", "json", "text", "markdown"].includes(requested))
          throw new Error('"kind" must be auto, csv, json, text, or markdown');
        const kind = detectKind(data, requested);
        const parsed = parseRows(data, kind);
        if (parsed.rows.length > MAX_IMPORT_ROWS)
          throw new Error(`Import has ${parsed.rows.length} rows; limit is ${MAX_IMPORT_ROWS}`);
        const db = await getDb(name);
        importRows(db, table, parsed.columns, parsed.rows, args.replace === true);
        return serialize({
          db: name,
          table,
          kind,
          columns: parsed.columns,
          imported_rows: parsed.rows.length,
        });
      },
    },
    {
      name: "sql_list_tables",
      description: "List tables and columns in a session SQLite database.",
      inputSchema: schema(
        { db: { type: "string", description: "Session database name. Defaults to default." } },
        [],
      ),
      async handler(args) {
        const name = dbName(args);
        const db = await getDb(name);
        const tables = db
          .exec(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )[0]
          ?.values.map((row) => String(row[0])) ?? [];
        return serialize({
          db: name,
          tables: tables.map((table) => ({
            name: table,
            columns:
              db.exec(`PRAGMA table_info(${quoteIdentifier(table)})`)[0]?.values.map((row) => ({
                name: row[1],
                type: row[2],
                not_null: row[3],
                default_value: row[4],
                primary_key: row[5],
              })) ?? [],
          })),
        });
      },
    },
    {
      name: "sql_export_db",
      description:
        "Export a session SQLite database as base64 so it can be saved with create_file/update_file and loaded later.",
      inputSchema: schema(
        { db: { type: "string", description: "Session database name. Defaults to default." } },
        [],
      ),
      async handler(args) {
        const name = dbName(args);
        const db = await getDb(name);
        const bytes = db.export();
        return JSON.stringify({ db: name, bytes: bytes.length, base64: bytesToBase64(bytes) });
      },
    },
    {
      name: "sql_import_db",
      description:
        "Load a base64 SQLite database export into memory. Use read_file first if the export was saved locally.",
      inputSchema: schema(
        {
          db: { type: "string", description: "Session database name. Defaults to default." },
          base64: { type: "string", description: "Base64 database bytes from sql_export_db." },
          replace: {
            type: "boolean",
            description:
              "Replace an existing in-memory database. Defaults to false; set true to overwrite it.",
          },
        },
        ["base64"],
      ),
      async handler(args) {
        const name = dbName(args);
        const replace = args.replace === true;
        if (!replace && databases.has(name))
          throw new Error(`Database "${name}" already exists`);
        const SQL = await sqlJs();
        const previous = databases.get(name);
        const next = new SQL.Database(base64ToBytes(nonEmptyString(args, "base64")));
        previous?.close();
        databases.set(name, next);
        return `Loaded database "${name}".`;
      },
    },
    {
      name: "sql_drop_db",
      description:
        "Drop one in-memory session SQLite database, or all session databases. Use when gathered data is no longer needed.",
      inputSchema: schema(
        {
          db: { type: "string", description: "Session database name. Defaults to default." },
          all: { type: "boolean", description: "Drop all session databases." },
        },
        [],
      ),
      async handler(args) {
        if (args.all === true) {
          for (const db of databases.values()) db.close();
          const count = databases.size;
          databases.clear();
          return `Dropped ${count} session database${count === 1 ? "" : "s"}.`;
        }
        const name = dbName(args);
        const stored = databases.get(name);
        if (!stored) return `Database "${name}" did not exist.`;
        stored.close();
        databases.delete(name);
        return `Dropped database "${name}".`;
      },
    },
  ];
}

const registry = createToolRegistry(
  SQL_SERVER_ID,
  SQL_SERVER_NAME,
  createSessionSqlTools(),
);

export const sessionSqlTools = registry.tools;
export const callSessionSqlTool = registry.call;
export { SQL_SERVER_ID };
