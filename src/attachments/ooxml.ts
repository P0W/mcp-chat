import { unzipSync } from "fflate";
import { formatBytes } from "./limits";
import { AttachmentError } from "./types";

// Minimal, dependency-light text extraction for Office Open XML files
// (.docx/.pptx/.xlsx). These are zip archives of XML parts; we inflate only
// the parts we need (bounded by a decompressed-size budget to defuse zip
// bombs) and pull text out with tolerant regex scanning, not a DOM, so it
// runs anywhere (browser, WebView, tests) without rendering anything.

export type OoxmlFormat = "docx" | "pptx" | "xlsx";

const LABEL: Record<OoxmlFormat, string> = {
  docx: "Word document",
  pptx: "PowerPoint presentation",
  xlsx: "Excel spreadsheet",
};

const WANTED: Record<OoxmlFormat, RegExp> = {
  docx: /^word\/document\.xml$/,
  pptx: /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)$/,
  xlsx: /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/,
};

const REQUIRED: Record<OoxmlFormat, string> = {
  docx: "word/document.xml",
  pptx: "ppt/presentation.xml",
  xlsx: "xl/workbook.xml",
};

function unreadable(name: string, format: OoxmlFormat): AttachmentError {
  return new AttachmentError(
    "unreadable",
    `${name}: couldn't read this ${LABEL[format]}. It may be corrupted, password-protected, or an older binary format.`,
  );
}

function readParts(
  name: string,
  bytes: Uint8Array,
  format: OoxmlFormat,
  maxBytes: number,
): Map<string, string> {
  let budget = maxBytes;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        if (!WANTED[format].test(f.name)) return false;
        // fflate allocates exactly the declared size (and never grows past
        // it), so bounding the declared sizes bounds memory use.
        budget -= f.originalSize;
        if (budget < 0) {
          throw new AttachmentError(
            "too-large",
            `${name}: the document expands to more than ${formatBytes(maxBytes)} of content.`,
          );
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw unreadable(name, format);
  }
  const decoder = new TextDecoder("utf-8");
  const parts = new Map<string, string>();
  for (const [path, data] of Object.entries(files)) parts.set(path, decoder.decode(data));
  if (!parts.has(REQUIRED[format])) throw unreadable(name, format);
  return parts;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (m, e: string) => {
    if (e.startsWith("#")) {
      const hex = e[1] === "x" || e[1] === "X";
      const cp = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
      return valid ? String.fromCodePoint(cp) : "";
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    out[m[1]!] = decodeXmlEntities(m[2]!);
  }
  return out;
}

/** Map relationship Id -> archive path, resolved against `baseDir`. */
function relationships(xml: string | undefined, baseDir: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.Id || !a.Target) continue;
    const target = a.Target.startsWith("/")
      ? a.Target.slice(1)
      : normalizeArchivePath(`${baseDir}/${a.Target}`);
    map.set(a.Id, target);
  }
  return map;
}

function normalizeArchivePath(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function tidy(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function docxText(parts: Map<string, string>): string {
  const xml = parts.get("word/document.xml") ?? "";
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br|cr)\b[^>]*\/>|<\/w:p>/g;
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    else if (m[2] === "tab") out += "\t";
    else out += "\n";
  }
  return tidy(out);
}

function slideNumber(path: string): number {
  return Number(/slide(\d+)\.xml$/.exec(path)?.[1] ?? 0);
}

function pptxText(parts: Map<string, string>): string {
  const rels = relationships(parts.get("ppt/_rels/presentation.xml.rels"), "ppt");
  const ordered: string[] = [];
  const presentation = parts.get("ppt/presentation.xml") ?? "";
  for (const m of presentation.matchAll(/<p:sldId\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const target = a["r:id"] ? rels.get(a["r:id"]) : undefined;
    if (target && parts.has(target) && !ordered.includes(target)) ordered.push(target);
  }
  // Fall back to file-name order for anything the presentation didn't list.
  const rest = [...parts.keys()]
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p) && !ordered.includes(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
  const sections: string[] = [];
  [...ordered, ...rest].forEach((path, i) => {
    let text = "";
    const re = /<a:t>([^<]*)<\/a:t>|<a:br\b[^>]*\/>|<\/a:p>/g;
    for (const m of (parts.get(path) ?? "").matchAll(re)) {
      text += m[1] !== undefined ? decodeXmlEntities(m[1]) : "\n";
    }
    const body = tidy(text);
    if (body) sections.push(`## Slide ${i + 1}\n${body}`);
  });
  return sections.join("\n\n");
}

function innerTexts(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)) out += decodeXmlEntities(m[1]!);
  return out;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  for (const m of xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    // Phonetic runs (<rPh>) repeat the reading guide; skip them.
    out.push(innerTexts((m[1] ?? "").replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  }
  return out;
}

function columnIndex(ref: string | undefined): number | undefined {
  const letters = ref ? /^([A-Z]+)/i.exec(ref)?.[1] : undefined;
  if (!letters) return undefined;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// Guard against sparse sheets with far-right cells (e.g. XFD1) blowing up rows.
const MAX_COLUMNS = 1024;

function sheetCsv(xml: string, shared: string[]): string {
  const lines: string[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attrs(c[1] ?? "");
      const body = c[2] ?? "";
      const raw = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      let value: string;
      if (a.t === "s") value = shared[Number(raw)] ?? "";
      else if (a.t === "inlineStr") value = innerTexts(body);
      else if (a.t === "b") value = raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : "";
      else value = raw !== undefined ? decodeXmlEntities(raw) : "";
      const col = columnIndex(a.r) ?? cells.length;
      if (col >= MAX_COLUMNS) continue;
      while (cells.length < col) cells.push("");
      cells[col] = value;
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    lines.push(cells.map(csvCell).join(","));
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  return lines.join("\n");
}

function xlsxText(parts: Map<string, string>): string {
  const shared = sharedStrings(parts.get("xl/sharedStrings.xml"));
  const rels = relationships(parts.get("xl/_rels/workbook.xml.rels"), "xl");
  const sheets: { name: string; path: string }[] = [];
  for (const m of (parts.get("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)) {
    const a = attrs(m[0]);
    const path = a["r:id"] ? rels.get(a["r:id"]) : undefined;
    if (path && parts.has(path)) sheets.push({ name: a.name ?? path, path });
  }
  if (!sheets.length) {
    for (const path of [...parts.keys()].filter((p) => p.startsWith("xl/worksheets/")).sort()) {
      sheets.push({ name: path.slice("xl/worksheets/".length, -4), path });
    }
  }
  const sections: string[] = [];
  for (const s of sheets) {
    const csv = sheetCsv(parts.get(s.path) ?? "", shared);
    if (csv) sections.push(`## Sheet: ${s.name}\n${csv}`);
  }
  return sections.join("\n\n");
}

/** Extract readable text from a .docx/.pptx/.xlsx file. */
export function extractOoxmlText(
  name: string,
  bytes: Uint8Array,
  format: OoxmlFormat,
  maxArchiveBytes: number,
): string {
  const parts = readParts(name, bytes, format, maxArchiveBytes);
  if (format === "docx") return docxText(parts);
  if (format === "pptx") return pptxText(parts);
  return xlsxText(parts);
}
