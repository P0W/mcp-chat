// Public surface of the attachment feature. The rest of the app should import
// from here rather than reaching into individual modules.
export type {
  AttachmentCapabilities,
  AttachmentFormat,
  AttachmentInputMode,
  AttachmentKind,
  AttachmentLimits,
  ChatAttachment,
} from "./types";
export { AttachmentError } from "./types";
export { ACCEPT_ATTRIBUTE, FORMATS, SAFE_PREVIEW_MIMES, formatSpec } from "./formats";
export { DEFAULT_ATTACHMENT_LIMITS, formatBytes, resolveAttachmentLimits } from "./limits";
export { sanitizeFileName } from "./validate";
export { processFile } from "./process";
export {
  AttachmentQueue,
  type AttachmentQueueState,
  type PendingAttachment,
} from "./queue";
export { useAttachmentQueue } from "./useAttachmentQueue";
export { resolveAttachmentCapabilities } from "./capabilities";
export {
  buildUserParts,
  estimateAttachmentChars,
  planDelivery,
  toAnthropicContent,
  toOpenAIContent,
  type DeliveryPlan,
} from "./transport";
