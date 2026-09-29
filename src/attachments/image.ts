import { formatBytes } from "./limits";
import type { FormatSpec } from "./formats";
import { AttachmentError, type AttachmentLimits } from "./types";

export interface NormalizedImage {
  bytes: Uint8Array;
  mimeType: string;
}

export type ImageNormalizer = (
  name: string,
  bytes: Uint8Array,
  spec: FormatSpec,
  limits: AttachmentLimits,
) => Promise<NormalizedImage>;

function canvasToBytes(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null);
        blob.arrayBuffer().then(
          (buf) => resolve(new Uint8Array(buf)),
          () => resolve(null),
        );
      },
      type,
      quality,
    );
  });
}

/**
 * Decode a raster image in the browser (which also proves it is a real
 * image), then re-encode it only when needed: BMP is converted to PNG because
 * providers don't accept it, oversized dimensions are scaled down, and
 * payloads over the provider image limit are recompressed as JPEG.
 * Outside a browser it passes the bytes through unchanged.
 */
export const normalizeImageInBrowser: ImageNormalizer = async (
  name,
  bytes,
  spec,
  limits,
) => {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return { bytes, mimeType: spec.mimeType };
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: spec.mimeType }));
  } catch {
    throw new AttachmentError(
      "unreadable",
      `${name}: couldn't decode this image. It may be corrupted.`,
    );
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    const tooWide = longEdge > limits.maxImageDimension;
    const tooHeavy = bytes.length > limits.maxImageBytes;
    if (spec.format !== "bmp" && !tooWide && !tooHeavy) {
      return { bytes, mimeType: spec.mimeType };
    }
    const scale = tooWide ? limits.maxImageDimension / longEdge : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");

    const encode = async (type: string): Promise<Uint8Array | null> => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (type === "image/jpeg") {
        // JPEG has no alpha; flatten transparency onto white.
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvasToBytes(canvas, type, type === "image/jpeg" ? 0.85 : undefined);
    };

    let mimeType = spec.format === "jpeg" ? "image/jpeg" : "image/png";
    let out = await encode(mimeType);
    if ((!out || out.length > limits.maxImageBytes) && mimeType !== "image/jpeg") {
      mimeType = "image/jpeg";
      out = await encode(mimeType);
    }
    if (!out) throw new Error("encode failed");
    if (out.length > limits.maxImageBytes) {
      throw new AttachmentError(
        "too-large",
        `${name}: the image is still larger than ${formatBytes(limits.maxImageBytes)} after compression.`,
      );
    }
    return { bytes: out, mimeType };
  } catch (e) {
    if (e instanceof AttachmentError) throw e;
    throw new AttachmentError("unreadable", `${name}: couldn't process this image.`);
  } finally {
    bitmap.close();
  }
};
