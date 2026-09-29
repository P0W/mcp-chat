import { forwardRef, useEffect, useRef, useState, type DragEvent } from "react";
import {
  ACCEPT_ATTRIBUTE,
  SAFE_PREVIEW_MIMES,
  formatBytes,
  formatSpec,
  planDelivery,
  type AttachmentCapabilities,
  type AttachmentQueueState,
  type ChatAttachment,
  type PendingAttachment,
} from "../attachments";

// Presentation for the attachment feature: picker button, drop zone, the
// pre-send tray, and read-only chips on sent messages. All state lives in the
// AttachmentQueue; these components only render it and forward user intent.

export const AttachButton = forwardRef<
  HTMLButtonElement,
  { onFiles: (files: File[]) => void; disabled?: boolean }
>(function AttachButton({ onFiles, disabled }, ref) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          // Reset so picking the same file again still fires change.
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <button
        ref={ref}
        type="button"
        className="btn btn-ghost aspect-square px-2.5 text-neutral-300"
        aria-label="Attach files"
        title="Attach files"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon />
      </button>
    </>
  );
});

function hasFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Drag-and-drop props for a container, plus whether files are hovering.
 * Also stops files dropped elsewhere in the window from navigating away.
 */
export function useFileDrop(onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const block = (e: globalThis.DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", block);
    window.addEventListener("drop", block);
    return () => {
      window.removeEventListener("dragover", block);
      window.removeEventListener("drop", block);
    };
  }, []);

  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files);
    },
  };
  return { dragging, props };
}

function deliveryHint(
  item: PendingAttachment,
  caps: AttachmentCapabilities,
): string | null {
  if (!item.attachment) return null;
  const plan = planDelivery(item.attachment, caps);
  if (plan.mode === "note") return `Won't be sent: ${plan.reason}.`;
  if (plan.mode === "text" && item.kind === "image") return "Sent as text markup.";
  if (plan.mode === "text" && item.format === "pdf") return "Sent as extracted text.";
  if (item.attachment.truncated) return "Text was truncated to fit the limit.";
  return null;
}

export function AttachmentTray({
  state,
  caps,
  onRemove,
  onDismissError,
  onEmpty,
}: {
  state: AttachmentQueueState;
  caps: AttachmentCapabilities;
  onRemove: (id: string) => void;
  onDismissError: (id: string) => void;
  /** Called after the last item is removed, e.g. to move focus. */
  onEmpty?: () => void;
}) {
  const removeRefs = useRef(new Map<string, HTMLButtonElement>());

  function remove(index: number) {
    const item = state.items[index];
    if (!item) return;
    // Keep keyboard focus in the tray: next item, else previous, else caller.
    const neighbour = state.items[index + 1] ?? state.items[index - 1];
    onRemove(item.id);
    const target = neighbour && removeRefs.current.get(neighbour.id);
    if (target) target.focus();
    else onEmpty?.();
  }

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {state.announcement}
      </div>
      {state.errors.length > 0 && (
        <div className="mb-2 space-y-1">
          {state.errors.map((e) => (
            <div
              key={e.id}
              role="alert"
              className="flex items-start justify-between gap-2 rounded-lg border border-red-900/40 bg-red-950/40 px-2 py-1.5 text-xs text-red-300"
            >
              <span className="break-words">{e.message}</span>
              <button
                type="button"
                className="shrink-0 text-red-200 underline"
                aria-label={`Dismiss: ${e.message}`}
                onClick={() => onDismissError(e.id)}
              >
                dismiss
              </button>
            </div>
          ))}
        </div>
      )}
      {state.items.length > 0 && (
        <ul className="mb-2 flex gap-2 overflow-x-auto pb-1" aria-label="Attachments to send">
          {state.items.map((item, index) => {
            const hint = deliveryHint(item, caps);
            return (
              <li
                key={item.id}
                className="flex w-56 shrink-0 items-center gap-2 rounded-xl border border-neutral-800 bg-neutral-900 p-2"
                aria-busy={item.status === "processing"}
              >
                <Thumb
                  url={item.previewUrl}
                  kind={item.kind}
                  processing={item.status === "processing"}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium" title={item.name}>
                    {item.name}
                  </div>
                  <div className="truncate text-[11px] text-neutral-500">
                    {item.status === "processing"
                      ? "Processing..."
                      : `${item.label} · ${formatBytes(item.size)}`}
                  </div>
                  {hint && (
                    <div className="truncate text-[11px] text-amber-400" title={hint}>
                      {hint}
                    </div>
                  )}
                </div>
                <button
                  ref={(el) => {
                    if (el) removeRefs.current.set(item.id, el);
                    else removeRefs.current.delete(item.id);
                  }}
                  type="button"
                  className="btn-ghost shrink-0 rounded-lg p-1 text-neutral-400"
                  aria-label={`Remove ${item.name}`}
                  title="Remove"
                  onClick={() => remove(index)}
                >
                  <CloseIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Thumb({
  url,
  kind,
  processing,
}: {
  url?: string | undefined;
  kind: "image" | "document";
  processing?: boolean;
}) {
  if (processing) {
    return (
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-800">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
      </div>
    );
  }
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-10 w-10 shrink-0 rounded-lg object-cover"
        draggable={false}
      />
    );
  }
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-neutral-800 text-neutral-400">
      {kind === "image" ? <ImageIcon /> : <DocumentIcon />}
    </div>
  );
}

/** Read-only attachment chips for a sent (or queued) user message. */
export function MessageAttachments({ attachments }: { attachments: ChatAttachment[] }) {
  return (
    <ul className="mb-1 flex flex-wrap justify-end gap-1.5" aria-label="Attached files">
      {attachments.map((a) => {
        // Only raster types are rendered, from our own normalized base64;
        // SVG and anything else get a generic icon.
        const src =
          a.kind === "image" && a.data && SAFE_PREVIEW_MIMES.has(a.mimeType)
            ? `data:${a.mimeType};base64,${a.data}`
            : undefined;
        return (
          <li
            key={a.id}
            className="flex max-w-[16rem] items-center gap-2 rounded-xl border border-indigo-400/30 bg-indigo-950/40 p-1.5 pr-2.5 text-xs"
          >
            <Thumb url={src} kind={a.kind} />
            <div className="min-w-0">
              <div className="truncate font-medium" title={a.name}>
                {a.name}
              </div>
              <div className="truncate text-[11px] text-indigo-100/70">
                {formatSpec(a.format).label} · {formatBytes(a.size)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function PaperclipIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      <path d="M15.5 9.5l-5.8 5.8a3.5 3.5 0 01-5-5l6.3-6.3a2.3 2.3 0 013.3 3.3l-6.2 6.2a1.2 1.2 0 01-1.7-1.7l5.6-5.6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-4 w-4"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2"
    >
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.6"
    >
      <path d="M5 2.5h6.5L15 6v11.5H5z" />
      <path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-5 w-5"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="round"
      strokeWidth="1.6"
    >
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M3 13l4-4 3 3 2-2 5 5" />
      <circle cx="13" cy="7.5" r="1" />
    </svg>
  );
}
