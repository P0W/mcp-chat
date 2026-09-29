import { hasUtf16Bom } from "./formats";
import { AttachmentError } from "./types";

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64ByteLength(b64: string): number {
  const len = b64.length;
  if (!len) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

/**
 * Decode a text file. Honors UTF-8/UTF-16 BOMs; otherwise requires valid
 * UTF-8 so binary files renamed to .txt/.csv/.md are rejected.
 */
export function decodeText(name: string, bytes: Uint8Array): string {
  let encoding = "utf-8";
  if (hasUtf16Bom(bytes)) encoding = bytes[0] === 0xff ? "utf-16le" : "utf-16be";
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    throw new AttachmentError(
      "mismatch",
      `${name}: the file isn't valid UTF-8 text.`,
    );
  }
  if (text.includes("\u0000")) {
    throw new AttachmentError("mismatch", `${name}: the file looks like binary data.`);
  }
  return text.replace(/\r\n?/g, "\n");
}

export function truncateText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let end = maxChars;
  // Don't split a UTF-16 surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return { text: text.slice(0, end), truncated: true };
}
