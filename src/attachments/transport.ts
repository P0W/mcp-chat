import { base64ByteLength, truncateText } from "./encoding";
import { formatSpec } from "./formats";
import { DEFAULT_ATTACHMENT_LIMITS, formatBytes } from "./limits";
import type {
  AttachmentCapabilities,
  AttachmentLimits,
  ChatAttachment,
} from "./types";

// Transport boundary: turns a user message plus its attachments into
// provider-neutral parts, then into the OpenAI Chat Completions or Anthropic
// Messages content shapes. Limits are re-enforced here, independent of the UI,
// so persisted or queued messages can never push oversized payloads to a
// provider. Anything a provider can't consume degrades to a short text note.

export type NeutralPart =
  | { type: "text"; text: string }
  | { type: "image"; name: string; mimeType: string; data: string }
  | { type: "pdf"; name: string; data: string };

export type DeliveryPlan =
  | { mode: "image" | "pdf" | "text" }
  | { mode: "note"; reason: string };

/** Image types every supported vision provider accepts inline. */
export const NATIVE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Rough prompt cost of one inline image, in characters (~1.6k tokens). */
const IMAGE_CHAR_ESTIMATE = 6_400;

export function planDelivery(
  a: ChatAttachment,
  caps: AttachmentCapabilities,
): DeliveryPlan {
  if (a.kind === "image" && a.data) {
    if (!caps.images) {
      return { mode: "note", reason: "the selected provider/model doesn't accept image input" };
    }
    if (!NATIVE_IMAGE_MIMES.has(a.mimeType)) {
      return { mode: "note", reason: `${formatSpec(a.format).label}s can't be sent to this provider` };
    }
    return { mode: "image" };
  }
  if (a.format === "pdf" && a.data && caps.pdf) return { mode: "pdf" };
  if (a.text) return { mode: "text" };
  if (a.format === "pdf") {
    return {
      mode: "note",
      reason: "it has no extractable text and the selected provider/model doesn't accept PDF input",
    };
  }
  return { mode: "note", reason: "no content could be extracted" };
}

function deliveredSize(a: ChatAttachment, mode: DeliveryPlan["mode"]): number {
  if (mode === "image" || mode === "pdf") return base64ByteLength(a.data ?? "");
  if (mode === "text") return a.text?.length ?? 0;
  return 0;
}

function safeName(name: string): string {
  return name.replace(/["<>\r\n]/g, "_");
}

function describe(a: ChatAttachment): string {
  return `"${safeName(a.name)}" (${formatSpec(a.format).label}, ${formatBytes(a.size)})`;
}

function note(a: ChatAttachment, reason: string): NeutralPart {
  return { type: "text", text: `[Attachment ${describe(a)} not included: ${reason}.]` };
}

function documentText(a: ChatAttachment, limits: AttachmentLimits): string {
  const cut = truncateText(a.text ?? "", limits.maxTextChars);
  // Keep the document from closing its own wrapper early.
  const body = cut.text.replace(/<\/attachment/gi, "<\\/attachment");
  const truncated = cut.truncated || a.truncated
    ? `\n[Truncated: only the first ${cut.text.length.toLocaleString("en-US")} characters were extracted.]`
    : "";
  const spec = formatSpec(a.format);
  return (
    `<attachment name="${safeName(a.name)}" type="${spec.label}" size="${formatBytes(a.size)}">\n` +
    `${body}${truncated}\n</attachment>`
  );
}

/**
 * Provider-neutral parts for a user message: attachments first (as models
 * are recommended to see media before the question), then the typed text.
 */
export function buildUserParts(
  message: { content: string; attachments?: ChatAttachment[] | undefined },
  caps: AttachmentCapabilities,
  limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS,
): NeutralPart[] {
  const parts: NeutralPart[] = [];
  let total = 0;
  (message.attachments ?? []).forEach((a, index) => {
    let plan = planDelivery(a, caps);
    if (index >= limits.maxFiles) {
      plan = { mode: "note", reason: `only ${limits.maxFiles} attachments are allowed per message` };
    } else if (plan.mode !== "note") {
      // Text is truncated to maxTextChars rather than rejected.
      const size =
        plan.mode === "text"
          ? Math.min(deliveredSize(a, plan.mode), limits.maxTextChars)
          : deliveredSize(a, plan.mode);
      const perFileMax = plan.mode === "image" ? limits.maxImageBytes : limits.maxFileBytes;
      if (plan.mode !== "text" && size > perFileMax) {
        plan = { mode: "note", reason: `it exceeds the ${formatBytes(perFileMax)} size limit` };
      } else if (total + size > limits.maxTotalBytes) {
        plan = {
          mode: "note",
          reason: `attachments exceed the ${formatBytes(limits.maxTotalBytes)} per-message limit`,
        };
      } else {
        total += size;
      }
    }
    switch (plan.mode) {
      case "image":
        parts.push({ type: "text", text: `[Attached image: ${safeName(a.name)}]` });
        parts.push({ type: "image", name: safeName(a.name), mimeType: a.mimeType, data: a.data! });
        break;
      case "pdf":
        parts.push({ type: "pdf", name: safeName(a.name), data: a.data! });
        break;
      case "text":
        parts.push({ type: "text", text: documentText(a, limits) });
        break;
      case "note":
        parts.push(note(a, plan.reason));
        break;
    }
  });
  if (message.content) parts.push({ type: "text", text: message.content });
  return parts;
}

/** OpenAI Chat Completions `content`: a plain string when it's all text. */
export function toOpenAIContent(parts: NeutralPart[]): string | unknown[] {
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => (p as { text: string }).text).join("\n\n");
  }
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      return { type: "image_url", image_url: { url: `data:${p.mimeType};base64,${p.data}` } };
    }
    return {
      type: "file",
      file: { filename: p.name, file_data: `data:application/pdf;base64,${p.data}` },
    };
  });
}

/** Anthropic Messages content blocks. */
export function toAnthropicContent(parts: NeutralPart[]): unknown[] {
  return parts.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") {
      return { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } };
    }
    return {
      type: "document",
      title: p.name,
      source: { type: "base64", media_type: "application/pdf", data: p.data },
    };
  });
}

/** Approximate prompt size of a message's attachments, in characters. */
export function estimateAttachmentChars(attachments: ChatAttachment[] | undefined): number {
  let total = 0;
  for (const a of attachments ?? []) {
    if (a.kind === "image" && a.data) total += IMAGE_CHAR_ESTIMATE;
    else if (a.format === "pdf" && a.data && !a.text) total += IMAGE_CHAR_ESTIMATE;
    else total += (a.text?.length ?? 0) + 200;
  }
  return total;
}
