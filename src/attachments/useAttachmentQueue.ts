import { useEffect, useState, useSyncExternalStore } from "react";
import { DEFAULT_ATTACHMENT_LIMITS } from "./limits";
import { AttachmentQueue } from "./queue";
import type { AttachmentLimits } from "./types";

/** React binding for an AttachmentQueue that lives as long as the component. */
export function useAttachmentQueue(limits: AttachmentLimits = DEFAULT_ATTACHMENT_LIMITS) {
  const [queue] = useState(
    () =>
      new AttachmentQueue({
        limits,
        createObjectURL: (blob) => URL.createObjectURL(blob),
        revokeObjectURL: (url) => URL.revokeObjectURL(url),
      }),
  );
  const state = useSyncExternalStore(queue.subscribe, queue.getState);
  // Release object URLs and cancel in-flight processing on unmount.
  useEffect(() => () => queue.clear(), [queue]);
  return { queue, state };
}
