import { truncateText } from "./encoding";
import { AttachmentError } from "./types";

// PDF text extraction via pdf.js, loaded lazily so the ~1.8 MB library and
// its worker are only fetched the first time a PDF is attached. The PDF is
// only parsed for text; nothing is rendered, scripting stays disabled, and
// eval-based font compilation is turned off.

export interface PdfTextResult {
  text: string;
  truncated: boolean;
  pageCount: number;
}

type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfJs> | null = null;

function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, worker] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export async function extractPdfText(
  name: string,
  bytes: Uint8Array,
  maxChars: number,
  signal?: AbortSignal,
): Promise<PdfTextResult> {
  const pdfjs = await loadPdfJs();
  throwIfAborted(signal);
  const task = pdfjs.getDocument({
    // pdf.js transfers (detaches) the buffer it is given; hand it a copy.
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
    disableFontFace: true,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  });
  const onAbort = () => void task.destroy();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const doc = await task.promise;
    let text = "";
    let truncated = false;
    for (let i = 1; i <= doc.numPages; i++) {
      throwIfAborted(signal);
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if ("str" in item) pageText += item.str + (item.hasEOL ? "\n" : "");
      }
      page.cleanup();
      pageText = pageText.trim();
      if (pageText) text += `${text ? "\n\n" : ""}## Page ${i}\n${pageText}`;
      if (text.length >= maxChars) {
        const cut = truncateText(text, maxChars);
        truncated = cut.truncated || i < doc.numPages;
        text = cut.text;
        break;
      }
    }
    return { text, truncated, pageCount: doc.numPages };
  } catch (e) {
    throwIfAborted(signal);
    if ((e as Error)?.name === "PasswordException") {
      throw new AttachmentError(
        "unreadable",
        `${name}: password-protected PDFs aren't supported.`,
      );
    }
    throw new AttachmentError(
      "unreadable",
      `${name}: couldn't read this PDF. It may be corrupted.`,
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    void task.destroy();
  }
}
