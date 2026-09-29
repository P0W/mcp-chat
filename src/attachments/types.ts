// Attachment domain types. Kept free of React, fetch and provider details so
// every other attachment module (validation, parsing, UI, transport) can share
// them without pulling in each other.

export type AttachmentFormat =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "txt"
  | "md"
  | "csv"
  | "jpeg"
  | "png"
  | "gif"
  | "webp"
  | "bmp"
  | "svg";

export type AttachmentKind = "image" | "document";

/**
 * A processed, request-ready attachment. Persisted with its chat message in
 * the on-device IndexedDB chat record so later turns can still reference it;
 * never uploaded anywhere except the configured LLM provider.
 */
export interface ChatAttachment {
  id: string;
  /** Sanitized display/file name. */
  name: string;
  format: AttachmentFormat;
  kind: AttachmentKind;
  /** MIME type of `data` (after normalization), derived from content, not the client. */
  mimeType: string;
  /** Original file size in bytes. */
  size: number;
  /** Base64 payload for provider-native input (raster images, PDFs). */
  data?: string;
  /** Extracted/normalized text for text-capable delivery. */
  text?: string;
  /** True when `text` was cut at the configured character limit. */
  truncated?: boolean;
}

/** How a provider's configured model accepts attachments. */
export type AttachmentInputMode = "auto" | "text" | "images" | "images+pdf";

export interface AttachmentCapabilities {
  /** Accepts inline base64 JPEG/PNG/GIF/WebP images. */
  images: boolean;
  /** Accepts inline base64 PDF documents. */
  pdf: boolean;
}

export interface AttachmentLimits {
  /** Max size of a single selected file, in bytes. */
  maxFileBytes: number;
  /** Max number of attachments per message. */
  maxFiles: number;
  /** Max combined size of all attachments on one message, in bytes. */
  maxTotalBytes: number;
  /** Max extracted characters kept per document. */
  maxTextChars: number;
  /** Max encoded image size sent to a provider, in bytes. */
  maxImageBytes: number;
  /** Longest image edge in pixels; larger images are downscaled. */
  maxImageDimension: number;
  /** Max total decompressed bytes read from an Office (zip) file. */
  maxArchiveBytes: number;
}

export type AttachmentErrorCode =
  | "unsupported"
  | "mismatch"
  | "empty"
  | "too-large"
  | "too-many"
  | "total-too-large"
  | "unreadable";

export class AttachmentError extends Error {
  readonly code: AttachmentErrorCode;

  constructor(code: AttachmentErrorCode, message: string) {
    super(message);
    this.name = "AttachmentError";
    this.code = code;
  }
}
