import type { ProviderConfig } from "../types";
import type { AttachmentCapabilities, AttachmentInputMode } from "./types";

// Decide what attachment content a provider/model can consume. Users can pin
// this per provider in settings; "auto" uses conservative heuristics so an
// unknown text-only model gets extracted text instead of a hard API error.

const VISION_MODEL_RE =
  /(gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|chatgpt-4o|\bo[34]\b|\bo[34]-|claude|gemini|gemma-3|vision|[-_]vl\b|\bvl[-_]|llava|pixtral|llama-4|kimi-latest|kimi-k2\.5)/i;
const TEXT_ONLY_MODEL_RE =
  /(gpt-3\.5|o1-mini|o3-mini|deepseek-(chat|reasoner|coder)|embedding|whisper|tts)/i;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function modeCaps(mode: Exclude<AttachmentInputMode, "auto">): AttachmentCapabilities {
  return { images: mode !== "text", pdf: mode === "images+pdf" };
}

export function autoAttachmentCapabilities(
  provider: Pick<ProviderConfig, "protocol" | "baseUrl" | "model">,
): AttachmentCapabilities {
  const model = provider.model.toLowerCase();
  if (TEXT_ONLY_MODEL_RE.test(model)) return { images: false, pdf: false };
  const host = hostOf(provider.baseUrl);
  const vision = VISION_MODEL_RE.test(model);
  if (provider.protocol === "anthropic") {
    const claude = host === "api.anthropic.com" || model.includes("claude");
    return claude ? { images: true, pdf: true } : { images: vision, pdf: false };
  }
  if (host === "api.openai.com") return { images: vision, pdf: vision };
  // OpenRouter normalizes image and PDF file parts across its models.
  if (host === "openrouter.ai") return { images: true, pdf: true };
  if (host === "generativelanguage.googleapis.com") return { images: true, pdf: false };
  return { images: vision, pdf: false };
}

export function resolveAttachmentCapabilities(
  provider: Pick<ProviderConfig, "protocol" | "baseUrl" | "model"> & {
    attachmentInput?: AttachmentInputMode | undefined;
  },
): AttachmentCapabilities {
  const mode = provider.attachmentInput ?? "auto";
  return mode === "auto" ? autoAttachmentCapabilities(provider) : modeCaps(mode);
}
