import { formatBytes } from "./limits";
import { formatForFileName, type FormatSpec } from "./formats";
import {
  AttachmentError,
  type AttachmentLimits,
} from "./types";

const MAX_NAME_LENGTH = 120;
// Control chars, bidi overrides/isolates and zero-width chars can spoof what a
// user (or model) sees; path and shell-hostile characters are replaced.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;
const RESERVED = /[/\\:*?"<>|`[\]{}]/g;

/** Make a user-supplied file name safe to display and embed in prompts. */
export function sanitizeFileName(raw: string): string {
  // Drop any directory component a browser or drag source may include.
  const base = raw.split(/[/\\]/).pop() ?? "";
  let name = base
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(RESERVED, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (name.length > MAX_NAME_LENGTH) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME_LENGTH - ext.length).trimEnd() + ext;
  }
  if (!name) name = "attachment";
  return name;
}

/** Declared types we can't learn anything from; content sniffing decides. */
const UNINFORMATIVE_MIMES = new Set(["", "application/octet-stream"]);

export function isDeclaredMimeCompatible(spec: FormatSpec, declared: string): boolean {
  const mime = declared.split(";")[0]!.trim().toLowerCase();
  return UNINFORMATIVE_MIMES.has(mime) || spec.declaredMimes.includes(mime);
}

export interface FileMeta {
  name: string;
  size: number;
  type: string;
}

export interface PrecheckedFile {
  name: string;
  spec: FormatSpec;
}

/**
 * Cheap checks that need only file metadata (no reading): extension
 * allowlist, declared-MIME consistency, and per-file size. Throws
 * AttachmentError with a user-facing message on rejection.
 */
export function precheckFile(meta: FileMeta, limits: AttachmentLimits): PrecheckedFile {
  const name = sanitizeFileName(meta.name);
  const spec = formatForFileName(name);
  if (!spec) {
    throw new AttachmentError(
      "unsupported",
      `${name}: this file type isn't supported.`,
    );
  }
  if (!isDeclaredMimeCompatible(spec, meta.type)) {
    throw new AttachmentError(
      "mismatch",
      `${name}: the file's type (${meta.type}) doesn't match its .${spec.extensions[0]} extension.`,
    );
  }
  if (meta.size <= 0) {
    throw new AttachmentError("empty", `${name}: the file is empty.`);
  }
  if (meta.size > limits.maxFileBytes) {
    throw new AttachmentError(
      "too-large",
      `${name} is ${formatBytes(meta.size)}; the limit is ${formatBytes(limits.maxFileBytes)} per file.`,
    );
  }
  return { name, spec };
}

/** Verify the file's leading bytes match the format implied by its extension. */
export function verifyContent(name: string, spec: FormatSpec, head: Uint8Array): void {
  if (!spec.sniff(head)) {
    throw new AttachmentError(
      "mismatch",
      `${name}: the contents don't look like a valid ${spec.label}.`,
    );
  }
}

/**
 * Check whether a file can join the current selection without breaking the
 * per-message count or total-size limits. Throws AttachmentError if not.
 */
export function checkSelectionLimits(
  current: { count: number; totalBytes: number },
  file: { name: string; size: number },
  limits: AttachmentLimits,
): void {
  if (current.count + 1 > limits.maxFiles) {
    throw new AttachmentError(
      "too-many",
      `${file.name} wasn't added: you can attach up to ${limits.maxFiles} files per message.`,
    );
  }
  if (current.totalBytes + file.size > limits.maxTotalBytes) {
    throw new AttachmentError(
      "total-too-large",
      `${file.name} wasn't added: attachments on one message can total at most ${formatBytes(limits.maxTotalBytes)}.`,
    );
  }
}
