import { decodeText, toBase64, truncateText } from "./encoding";
import { normalizeImageInBrowser, type ImageNormalizer } from "./image";
import { formatBytes } from "./limits";
import { extractOoxmlText } from "./ooxml";
import type { PdfTextResult } from "./pdf";
import { precheckFile, verifyContent } from "./validate";
import {
  AttachmentError,
  type AttachmentLimits,
  type ChatAttachment,
} from "./types";

export type PdfExtractor = (
  name: string,
  bytes: Uint8Array,
  maxChars: number,
  signal?: AbortSignal,
) => Promise<PdfTextResult>;

export interface ProcessDeps {
  extractPdf: PdfExtractor;
  normalizeImage: ImageNormalizer;
  newId: () => string;
}

const defaultExtractPdf: PdfExtractor = async (...args) =>
  (await import("./pdf")).extractPdfText(...args);

export const DEFAULT_PROCESS_DEPS: ProcessDeps = {
  extractPdf: defaultExtractPdf,
  normalizeImage: normalizeImageInBrowser,
  newId: () => crypto.randomUUID(),
};

/** The subset of the DOM File API the pipeline needs. */
export interface FileLike {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

/**
 * Validate a user-selected file and turn it into a request-ready attachment:
 * metadata prechecks, content sniffing against the extension, then per-format
 * text extraction or image normalization. File contents are never logged.
 */
export async function processFile(
  file: FileLike,
  limits: AttachmentLimits,
  deps: ProcessDeps = DEFAULT_PROCESS_DEPS,
  signal?: AbortSignal,
): Promise<ChatAttachment> {
  const { name, spec } = precheckFile(file, limits);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new AttachmentError("unreadable", `${name}: the file couldn't be read.`);
  }
  throwIfAborted(signal);
  // Re-check against the bytes actually read; `size` is only metadata.
  if (bytes.length > limits.maxFileBytes) {
    precheckFile({ name: file.name, type: file.type, size: bytes.length }, limits);
  }
  if (bytes.length === 0) throw new AttachmentError("empty", `${name}: the file is empty.`);
  verifyContent(name, spec, bytes.subarray(0, 8192));

  const base = {
    id: deps.newId(),
    name,
    format: spec.format,
    kind: spec.kind,
    mimeType: spec.mimeType,
    size: bytes.length,
  };

  switch (spec.format) {
    case "txt":
    case "md":
    case "csv":
    case "svg": {
      const cut = truncateText(decodeText(name, bytes), limits.maxTextChars);
      return withText(base, cut.text, cut.truncated);
    }
    case "docx":
    case "pptx":
    case "xlsx": {
      const text = extractOoxmlText(name, bytes, spec.format, limits.maxArchiveBytes);
      if (!text.trim()) {
        throw new AttachmentError("unreadable", `${name}: no text could be extracted.`);
      }
      const cut = truncateText(text, limits.maxTextChars);
      return withText(base, cut.text, cut.truncated);
    }
    case "pdf": {
      const pdf = await deps.extractPdf(name, bytes, limits.maxTextChars, signal);
      throwIfAborted(signal);
      const attachment: ChatAttachment = { ...base, data: toBase64(bytes) };
      return pdf.text.trim() ? withText(attachment, pdf.text, pdf.truncated) : attachment;
    }
    default: {
      const image = await deps.normalizeImage(name, bytes, spec, limits);
      throwIfAborted(signal);
      if (image.bytes.length > limits.maxImageBytes) {
        throw new AttachmentError(
          "too-large",
          `${name}: images can be at most ${formatBytes(limits.maxImageBytes)} after compression.`,
        );
      }
      return { ...base, mimeType: image.mimeType, data: toBase64(image.bytes) };
    }
  }
}

function withText(
  a: ChatAttachment,
  text: string,
  truncated: boolean,
): ChatAttachment {
  return truncated ? { ...a, text, truncated: true } : { ...a, text };
}
