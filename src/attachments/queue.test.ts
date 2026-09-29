import { describe, expect, it, vi } from "vitest";
import { BASE_ATTACHMENT_LIMITS } from "./limits";
import { AttachmentQueue, type FileProcessor } from "./queue";
import { AttachmentError, type ChatAttachment } from "./types";

function file(name: string, size = 10, type = ""): File {
  return new File([new Uint8Array(size) as BlobPart], name, { type });
}

function attachment(f: File): ChatAttachment {
  const isImage = f.name.endsWith(".png");
  return {
    id: `a-${f.name}`,
    name: f.name,
    format: isImage ? "png" : "txt",
    kind: isImage ? "image" : "document",
    mimeType: isImage ? "image/png" : "text/plain",
    size: f.size,
    ...(isImage ? { data: "AA==" } : { text: "hi" }),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(opts: { process?: FileProcessor; maxFiles?: number; maxTotalBytes?: number } = {}) {
  let n = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const queue = new AttachmentQueue({
    limits: {
      ...BASE_ATTACHMENT_LIMITS,
      ...(opts.maxFiles ? { maxFiles: opts.maxFiles } : {}),
      ...(opts.maxTotalBytes ? { maxTotalBytes: opts.maxTotalBytes } : {}),
    },
    process: opts.process ?? (async (f) => attachment(f)),
    createObjectURL: () => {
      const url = `blob:${++n}`;
      created.push(url);
      return url;
    },
    revokeObjectURL: (url) => revoked.push(url),
    newId: () => `id-${++n}`,
  });
  return { queue, created, revoked };
}

describe("AttachmentQueue", () => {
  it("adds, processes and hands over attachments", async () => {
    const { queue, created, revoked } = setup();
    const listener = vi.fn();
    queue.subscribe(listener);
    await queue.addFiles([file("a.txt"), file("b.png")]);
    const s = queue.getState();
    expect(s.processing).toBe(false);
    expect(s.items.map((i) => [i.name, i.status])).toEqual([
      ["a.txt", "ready"],
      ["b.png", "ready"],
    ]);
    // Only the verified raster image gets an object URL.
    expect(created).toHaveLength(1);
    expect(s.items[1]!.previewUrl).toBe(created[0]);
    expect(listener).toHaveBeenCalled();

    const taken = queue.takeReady();
    expect(taken?.map((a) => a.name)).toEqual(["a.txt", "b.png"]);
    expect(queue.getState().items).toHaveLength(0);
    expect(revoked).toEqual(created);
  });

  it("rejects unsupported files and reports errors without adding them", async () => {
    const { queue } = setup();
    await queue.addFiles([file("x.exe"), file("ok.txt")]);
    const s = queue.getState();
    expect(s.items.map((i) => i.name)).toEqual(["ok.txt"]);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]!.message).toMatch(/x\.exe/);
    expect(s.announcement).toBe("ok.txt attached.");
    queue.dismissError(s.errors[0]!.id);
    expect(queue.getState().errors).toHaveLength(0);
  });

  it("enforces the per-message count limit across additions", async () => {
    const { queue } = setup({ maxFiles: 2 });
    await queue.addFiles([file("a.txt"), file("b.txt")]);
    await queue.addFiles([file("c.txt")]);
    const s = queue.getState();
    expect(s.items).toHaveLength(2);
    expect(s.errors[0]!.message).toMatch(/up to 2 files/);
  });

  it("enforces the total size limit", async () => {
    const { queue } = setup({ maxTotalBytes: 25 });
    await queue.addFiles([file("a.txt", 10), file("b.txt", 10), file("c.txt", 10)]);
    expect(queue.getState().items.map((i) => i.name)).toEqual(["a.txt", "b.txt"]);
    expect(queue.getState().errors[0]!.message).toMatch(/c\.txt/);
  });

  it("blocks sending while processing, then allows it", async () => {
    const d = deferred<ChatAttachment>();
    const { queue } = setup({ process: () => d.promise });
    const done = queue.addFiles([file("a.txt")]);
    expect(queue.getState().processing).toBe(true);
    expect(queue.takeReady()).toBeNull();
    d.resolve(attachment(file("a.txt")));
    await done;
    expect(queue.getState().processing).toBe(false);
    expect(queue.takeReady()).toHaveLength(1);
  });

  it("removes a ready item and revokes its preview URL", async () => {
    const { queue, created, revoked } = setup();
    await queue.addFiles([file("a.png"), file("b.txt")]);
    const png = queue.getState().items[0]!;
    queue.remove(png.id);
    expect(queue.getState().items.map((i) => i.name)).toEqual(["b.txt"]);
    expect(revoked).toEqual(created);
    expect(queue.getState().announcement).toBe("a.png removed.");
  });

  it("cancels processing when an in-flight item is removed", async () => {
    const d = deferred<ChatAttachment>();
    let signal: AbortSignal | undefined;
    const { queue, created } = setup({
      process: (_f, _l, s) => {
        signal = s;
        return d.promise;
      },
    });
    const done = queue.addFiles([file("a.png")]);
    queue.remove(queue.getState().items[0]!.id);
    expect(signal?.aborted).toBe(true);
    d.resolve(attachment(file("a.png")));
    await done;
    expect(queue.getState().items).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it("drops items that fail processing and surfaces the error", async () => {
    const { queue } = setup({
      process: async () => {
        throw new AttachmentError("unreadable", "bad.txt: broken");
      },
    });
    await queue.addFiles([file("bad.txt")]);
    expect(queue.getState().items).toHaveLength(0);
    expect(queue.getState().errors.map((e) => e.message)).toEqual(["bad.txt: broken"]);
  });

  it("does not leak unexpected error details", async () => {
    const { queue } = setup({
      process: async () => {
        throw new Error("secret file contents");
      },
    });
    await queue.addFiles([file("a.txt")]);
    expect(queue.getState().errors[0]!.message).toBe("a.txt: couldn't process this file.");
  });

  it("clear() revokes URLs and aborts in-flight work", async () => {
    const d = deferred<ChatAttachment>();
    let signal: AbortSignal | undefined;
    let calls = 0;
    const { queue, created, revoked } = setup({
      process: (f, _l, s) => {
        if (calls++ === 0) return Promise.resolve(attachment(f));
        signal = s;
        return d.promise;
      },
    });
    await queue.addFiles([file("a.png")]);
    const pending = queue.addFiles([file("b.txt")]);
    queue.clear();
    expect(signal?.aborted).toBe(true);
    expect(revoked).toEqual(created);
    expect(queue.getState().items).toHaveLength(0);
    d.resolve(attachment(file("b.txt")));
    await pending;
    expect(queue.getState().items).toHaveLength(0);
  });
});
