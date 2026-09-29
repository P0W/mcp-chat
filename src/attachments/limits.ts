import type { AttachmentLimits } from "./types";

const MB = 1024 * 1024;

// Anthropic rejects base64 images over 5 MiB; 3.75 MiB of raw bytes encodes to
// exactly 5 MiB of base64, which also stays well inside OpenAI's limit.
const PROVIDER_IMAGE_MAX_BYTES = 3.75 * MB;

export const BASE_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = Object.freeze({
  maxFileBytes: 10 * MB,
  maxFiles: 5,
  maxTotalBytes: 20 * MB,
  maxTextChars: 100_000,
  maxImageBytes: PROVIDER_IMAGE_MAX_BYTES,
  maxImageDimension: 2048,
  maxArchiveBytes: 50 * MB,
});

type EnvLike = Record<string, string | boolean | undefined>;

function positive(env: EnvLike, key: string): number | undefined {
  const raw = env[key];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Build limits from build-time env vars, falling back to the base limits for
 * anything missing or invalid:
 *   VITE_ATTACHMENT_MAX_FILE_MB, VITE_ATTACHMENT_MAX_FILES,
 *   VITE_ATTACHMENT_MAX_TOTAL_MB, VITE_ATTACHMENT_MAX_TEXT_CHARS
 */
export function resolveAttachmentLimits(env: EnvLike = {}): AttachmentLimits {
  const fileMb = positive(env, "VITE_ATTACHMENT_MAX_FILE_MB");
  const files = positive(env, "VITE_ATTACHMENT_MAX_FILES");
  const totalMb = positive(env, "VITE_ATTACHMENT_MAX_TOTAL_MB");
  const textChars = positive(env, "VITE_ATTACHMENT_MAX_TEXT_CHARS");
  const limits: AttachmentLimits = { ...BASE_ATTACHMENT_LIMITS };
  if (fileMb) limits.maxFileBytes = Math.floor(fileMb * MB);
  if (files) limits.maxFiles = Math.floor(files);
  if (totalMb) limits.maxTotalBytes = Math.floor(totalMb * MB);
  if (textChars) limits.maxTextChars = Math.floor(textChars);
  limits.maxTotalBytes = Math.max(limits.maxTotalBytes, limits.maxFileBytes);
  return limits;
}

export const DEFAULT_ATTACHMENT_LIMITS: Readonly<AttachmentLimits> = Object.freeze(
  resolveAttachmentLimits(import.meta.env as unknown as EnvLike),
);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / MB;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}
