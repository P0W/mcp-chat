import type { AttachmentFormat, AttachmentKind } from "./types";

// Single source of truth for which files are accepted. Every format declares
// its allowed extensions, the client-declared MIME types we tolerate, the
// canonical MIME we actually use downstream, and a content sniffer. The
// client-provided MIME type is never trusted on its own.

export interface FormatSpec {
  format: AttachmentFormat;
  kind: AttachmentKind;
  label: string;
  extensions: readonly string[];
  /** Canonical MIME type, used instead of whatever the client declared. */
  mimeType: string;
  /** Client-declared MIME types that are plausible for this format. */
  declaredMimes: readonly string[];
  /** True when the leading bytes look like this format. */
  sniff: (head: Uint8Array) => boolean;
}

const OOXML_DECLARED = ["application/zip", "application/x-zip-compressed"];
const TEXT_DECLARED = ["text/plain"];

function startsWith(head: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (head.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (head[offset + i] !== sig[i]) return false;
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0));
}

const SIG = {
  pdf: ascii("%PDF-"),
  zip: [0x50, 0x4b, 0x03, 0x04],
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  gif87: ascii("GIF87a"),
  gif89: ascii("GIF89a"),
  riff: ascii("RIFF"),
  webp: ascii("WEBP"),
  bmp: ascii("BM"),
} as const;

function isPdf(head: Uint8Array): boolean {
  // The PDF spec lets readers accept the header within the first 1 KiB.
  const limit = Math.min(head.length - SIG.pdf.length, 1024);
  for (let i = 0; i <= limit; i++) if (startsWith(head, SIG.pdf, i)) return true;
  return false;
}

const isZip = (h: Uint8Array) => startsWith(h, SIG.zip);
const isJpeg = (h: Uint8Array) => startsWith(h, SIG.jpeg);
const isPng = (h: Uint8Array) => startsWith(h, SIG.png);
const isGif = (h: Uint8Array) => startsWith(h, SIG.gif87) || startsWith(h, SIG.gif89);
const isWebp = (h: Uint8Array) => startsWith(h, SIG.riff) && startsWith(h, SIG.webp, 8);
// "BM" + a header long enough to hold the DIB header size field.
const isBmp = (h: Uint8Array) => startsWith(h, SIG.bmp) && h.length >= 26;

const BINARY_SNIFFERS = [
  (h: Uint8Array) => startsWith(h, SIG.pdf),
  isZip,
  isJpeg,
  isPng,
  isGif,
  isWebp,
];

export function hasUtf16Bom(head: Uint8Array): boolean {
  return startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff]);
}

/** Heuristic: plain text has no NUL bytes and isn't a known binary format. */
export function looksLikeText(head: Uint8Array): boolean {
  if (hasUtf16Bom(head)) return true;
  if (BINARY_SNIFFERS.some((s) => s(head))) return false;
  const n = Math.min(head.length, 8192);
  for (let i = 0; i < n; i++) if (head[i] === 0) return false;
  return true;
}

function looksLikeSvg(head: Uint8Array): boolean {
  if (!looksLikeText(head)) return false;
  const prefix = new TextDecoder("utf-8").decode(head.subarray(0, 4096));
  return /<svg[\s>]/i.test(prefix);
}

export const FORMATS: readonly FormatSpec[] = [
  {
    format: "pdf",
    kind: "document",
    label: "PDF",
    extensions: ["pdf"],
    mimeType: "application/pdf",
    declaredMimes: ["application/pdf", "application/x-pdf"],
    sniff: isPdf,
  },
  {
    format: "docx",
    kind: "document",
    label: "Word document",
    extensions: ["docx"],
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    declaredMimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ...OOXML_DECLARED,
    ],
    sniff: isZip,
  },
  {
    format: "pptx",
    kind: "document",
    label: "PowerPoint presentation",
    extensions: ["pptx"],
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    declaredMimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ...OOXML_DECLARED,
    ],
    sniff: isZip,
  },
  {
    format: "xlsx",
    kind: "document",
    label: "Excel spreadsheet",
    extensions: ["xlsx"],
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    declaredMimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ...OOXML_DECLARED,
    ],
    sniff: isZip,
  },
  {
    format: "txt",
    kind: "document",
    label: "Text file",
    extensions: ["txt"],
    mimeType: "text/plain",
    declaredMimes: TEXT_DECLARED,
    sniff: looksLikeText,
  },
  {
    format: "md",
    kind: "document",
    label: "Markdown",
    extensions: ["md", "markdown"],
    mimeType: "text/markdown",
    declaredMimes: ["text/markdown", "text/x-markdown", ...TEXT_DECLARED],
    sniff: looksLikeText,
  },
  {
    format: "csv",
    kind: "document",
    label: "CSV",
    extensions: ["csv"],
    mimeType: "text/csv",
    declaredMimes: [
      "text/csv",
      "text/x-csv",
      "application/csv",
      "text/comma-separated-values",
      // Windows reports CSV as an Excel type when Office is installed.
      "application/vnd.ms-excel",
      ...TEXT_DECLARED,
    ],
    sniff: looksLikeText,
  },
  {
    format: "jpeg",
    kind: "image",
    label: "JPEG image",
    extensions: ["jpg", "jpeg", "jpe", "jfif"],
    mimeType: "image/jpeg",
    declaredMimes: ["image/jpeg", "image/jpg", "image/pjpeg"],
    sniff: isJpeg,
  },
  {
    format: "png",
    kind: "image",
    label: "PNG image",
    extensions: ["png"],
    mimeType: "image/png",
    declaredMimes: ["image/png", "image/x-png"],
    sniff: isPng,
  },
  {
    format: "gif",
    kind: "image",
    label: "GIF image",
    extensions: ["gif"],
    mimeType: "image/gif",
    declaredMimes: ["image/gif"],
    sniff: isGif,
  },
  {
    format: "webp",
    kind: "image",
    label: "WebP image",
    extensions: ["webp"],
    mimeType: "image/webp",
    declaredMimes: ["image/webp"],
    sniff: isWebp,
  },
  {
    format: "bmp",
    kind: "image",
    label: "BMP image",
    extensions: ["bmp", "dib"],
    mimeType: "image/bmp",
    declaredMimes: ["image/bmp", "image/x-bmp", "image/x-ms-bmp"],
    sniff: isBmp,
  },
  {
    format: "svg",
    kind: "image",
    label: "SVG image",
    extensions: ["svg"],
    mimeType: "image/svg+xml",
    declaredMimes: ["image/svg+xml", "text/xml", "application/xml", ...TEXT_DECLARED],
    sniff: looksLikeSvg,
  },
];

const BY_EXTENSION = new Map<string, FormatSpec>();
const BY_FORMAT = new Map<AttachmentFormat, FormatSpec>();
for (const spec of FORMATS) {
  BY_FORMAT.set(spec.format, spec);
  for (const ext of spec.extensions) BY_EXTENSION.set(ext, spec);
}

export function formatSpec(format: AttachmentFormat): FormatSpec {
  return BY_FORMAT.get(format)!;
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function formatForFileName(name: string): FormatSpec | undefined {
  return BY_EXTENSION.get(extensionOf(name));
}

/** Raster images that can be previewed with <img> without executing content. */
export const SAFE_PREVIEW_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

/** Value for the file input's `accept` attribute (extensions + MIME types). */
export const ACCEPT_ATTRIBUTE = Array.from(
  new Set([
    ...FORMATS.flatMap((f) => f.extensions.map((e) => `.${e}`)),
    ...FORMATS.map((f) => f.mimeType),
  ]),
).join(",");

/** Human-readable list of supported extensions, e.g. for help text. */
export const SUPPORTED_EXTENSIONS_LABEL = FORMATS.map((f) => f.extensions[0]!)
  .map((e) => `.${e}`)
  .join(", ");
