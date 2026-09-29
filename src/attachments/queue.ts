import { SAFE_PREVIEW_MIMES, formatSpec } from "./formats";
import { DEFAULT_ATTACHMENT_LIMITS } from "./limits";
import { DEFAULT_PROCESS_DEPS, processFile } from "./process";
import { checkSelectionLimits, precheckFile } from "./validate";
import {
  AttachmentError,
  type AttachmentFormat,
  type AttachmentKind,
  type AttachmentLimits,
  type ChatAttachment,
} from "./types";

// Framework-free state for the composer's pending attachments. React binds to
// it via useSyncExternalStore (see useAttachmentQueue); tests drive it
// directly. Owns every preview object URL it creates and revokes them on
// removal, send, and disposal.

export interface PendingAttachment {
  id: string;
  name: string;
  size: number;
  format: AttachmentFormat;
  kind: AttachmentKind;
  label: string;
  status: "processing" | "ready";
  /** blob: URL for a verified raster image thumbnail. Never set for SVG. */
  previewUrl?: string;
  attachment?: ChatAttachment;
}

export interface AttachmentNotice {
  id: string;
  message: string;
}

export interface AttachmentQueueState {
  items: readonly PendingAttachment[];
  errors: readonly AttachmentNotice[];
  /** Latest status message for a polite ARIA live region. */
  announcement: string;
  processing: boolean;
}

export type FileProcessor = (
  file: File,
  limits: AttachmentLimits,
  signal: AbortSignal,
) => Promise<ChatAttachment>;

export interface AttachmentQueueOptions {
  limits?: AttachmentLimits;
  process?: FileProcessor;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  newId?: () => string;
}

const MAX_VISIBLE_ERRORS = 5;

const EMPTY_STATE: AttachmentQueueState = Object.freeze({
  items: [],
  errors: [],
  announcement: "",
  processing: false,
});

function errorMessage(name: string, e: unknown): string {
  if (e instanceof AttachmentError) return e.message;
  return `${name}: couldn't process this file.`;
}

export class AttachmentQueue {
  readonly limits: AttachmentLimits;
  private state: AttachmentQueueState = EMPTY_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly process: FileProcessor;
  private readonly createObjectURL: ((blob: Blob) => string) | undefined;
  private readonly revokeObjectURL: ((url: string) => void) | undefined;
  private readonly newId: () => string;

  constructor(opts: AttachmentQueueOptions = {}) {
    this.limits = opts.limits ?? DEFAULT_ATTACHMENT_LIMITS;
    this.process =
      opts.process ?? ((file, limits, signal) => processFile(file, limits, DEFAULT_PROCESS_DEPS, signal));
    this.createObjectURL = opts.createObjectURL;
    this.revokeObjectURL = opts.revokeObjectURL;
    this.newId = opts.newId ?? (() => crypto.randomUUID());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): AttachmentQueueState => this.state;

  private set(patch: Partial<AttachmentQueueState>): void {
    const next = { ...this.state, ...patch };
    next.processing = next.items.some((i) => i.status === "processing");
    this.state = next;
    for (const l of this.listeners) l();
  }

  private patchItem(id: string, patch: Partial<PendingAttachment>): void {
    this.set({ items: this.state.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });
  }

  private addErrors(messages: string[]): void {
    if (!messages.length) return;
    const notices = messages.map((message) => ({ id: this.newId(), message }));
    this.set({
      errors: [...this.state.errors, ...notices].slice(-MAX_VISIBLE_ERRORS),
      announcement: messages.join(" "),
    });
  }

  private revoke(item: PendingAttachment): void {
    if (item.previewUrl) this.revokeObjectURL?.(item.previewUrl);
  }

  /**
   * Validate and start processing files. Files that fail cheap checks (type,
   * size, count, total) are rejected immediately with an error notice.
   * Resolves once every accepted file has finished processing.
   */
  async addFiles(files: Iterable<File>): Promise<void> {
    const errors: string[] = [];
    const accepted: string[] = [];
    const jobs: Promise<void>[] = [];
    for (const file of files) {
      let name = file.name;
      try {
        const pre = precheckFile(file, this.limits);
        name = pre.name;
        const items = this.state.items;
        checkSelectionLimits(
          { count: items.length, totalBytes: items.reduce((n, i) => n + i.size, 0) },
          { name, size: file.size },
          this.limits,
        );
        const id = this.newId();
        this.set({
          items: [
            ...items,
            {
              id,
              name,
              size: file.size,
              format: pre.spec.format,
              kind: pre.spec.kind,
              label: pre.spec.label,
              status: "processing",
            },
          ],
        });
        accepted.push(name);
        jobs.push(this.run(id, name, file));
      } catch (e) {
        errors.push(errorMessage(name, e));
      }
    }
    this.addErrors(errors);
    if (accepted.length) {
      const what = accepted.length === 1 ? accepted[0] : `${accepted.length} files`;
      this.set({
        announcement: [`Processing ${what}.`, ...errors].join(" "),
      });
    }
    await Promise.all(jobs);
  }

  private async run(id: string, name: string, file: File): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      const attachment = await this.process(file, this.limits, controller.signal);
      if (controller.signal.aborted || !this.has(id)) return;
      const previewable =
        attachment.kind === "image" &&
        SAFE_PREVIEW_MIMES.has(formatSpec(attachment.format).mimeType);
      const previewUrl =
        previewable && this.createObjectURL ? this.createObjectURL(file) : undefined;
      this.patchItem(id, {
        status: "ready",
        attachment,
        name: attachment.name,
        ...(previewUrl ? { previewUrl } : {}),
      });
      this.set({ announcement: `${name} attached.` });
    } catch (e) {
      if (controller.signal.aborted || !this.has(id)) return;
      this.set({ items: this.state.items.filter((i) => i.id !== id) });
      this.addErrors([errorMessage(name, e)]);
    } finally {
      this.controllers.delete(id);
    }
  }

  private has(id: string): boolean {
    return this.state.items.some((i) => i.id === id);
  }

  /** Remove a pending attachment, cancelling it if still processing. */
  remove(id: string): void {
    const item = this.state.items.find((i) => i.id === id);
    if (!item) return;
    this.controllers.get(id)?.abort();
    this.revoke(item);
    this.set({
      items: this.state.items.filter((i) => i.id !== id),
      announcement: `${item.name} removed.`,
    });
  }

  dismissError(id: string): void {
    this.set({ errors: this.state.errors.filter((e) => e.id !== id) });
  }

  /**
   * Hand over all ready attachments for sending and reset the tray. Returns
   * null while anything is still processing so a message can't be sent with
   * a partial set (or twice).
   */
  takeReady(): ChatAttachment[] | null {
    if (this.state.processing) return null;
    const attachments = this.state.items.flatMap((i) => (i.attachment ? [i.attachment] : []));
    for (const item of this.state.items) this.revoke(item);
    this.set({ items: [], errors: [], announcement: "" });
    return attachments;
  }

  /** Cancel processing, revoke preview URLs and empty the tray. */
  clear(): void {
    for (const c of this.controllers.values()) c.abort();
    this.controllers.clear();
    for (const item of this.state.items) this.revoke(item);
    this.set({ items: [], errors: [], announcement: "" });
  }
}
