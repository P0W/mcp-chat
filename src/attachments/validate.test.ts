import { describe, expect, it } from "vitest";
import { ACCEPT_ATTRIBUTE, FORMATS, formatForFileName } from "./formats";
import { BASE_ATTACHMENT_LIMITS, resolveAttachmentLimits } from "./limits";
import {
  checkSelectionLimits,
  isDeclaredMimeCompatible,
  precheckFile,
  sanitizeFileName,
  verifyContent,
} from "./validate";
import { AttachmentError } from "./types";

const limits = { ...BASE_ATTACHMENT_LIMITS };
const bytes = (...xs: number[]) => new Uint8Array(xs);
const text = (s: string) => new TextEncoder().encode(s);

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AttachmentError ? e.code : "other";
  }
  return undefined;
}

describe("format recognition", () => {
  it.each([
    ["report.pdf", "pdf"],
    ["Notes.DOCX", "docx"],
    ["deck.pptx", "pptx"],
    ["sheet.xlsx", "xlsx"],
    ["readme.txt", "txt"],
    ["README.md", "md"],
    ["data.csv", "csv"],
    ["photo.jpg", "jpeg"],
    ["photo.JPEG", "jpeg"],
    ["shot.png", "png"],
    ["anim.gif", "gif"],
    ["pic.webp", "webp"],
    ["old.bmp", "bmp"],
    ["logo.svg", "svg"],
  ])("maps %s to %s", (name, format) => {
    expect(formatForFileName(name)?.format).toBe(format);
  });

  it.each(["virus.exe", "legacy.doc", "old.xls", "archive.zip", "noext", "page.html"])(
    "rejects %s",
    (name) => {
      expect(formatForFileName(name)).toBeUndefined();
      expect(code(() => precheckFile({ name, size: 10, type: "" }, limits))).toBe("unsupported");
    },
  );

  it("builds an accept attribute with extensions and MIME types", () => {
    expect(ACCEPT_ATTRIBUTE).toContain(".pdf");
    expect(ACCEPT_ATTRIBUTE).toContain(".md");
    expect(ACCEPT_ATTRIBUTE).toContain("image/png");
    expect(FORMATS.every((f) => f.extensions.length > 0)).toBe(true);
  });
});

describe("declared MIME validation", () => {
  const spec = (n: string) => formatForFileName(n)!;

  it("accepts matching, empty, and generic declared types", () => {
    expect(isDeclaredMimeCompatible(spec("a.png"), "image/png")).toBe(true);
    expect(isDeclaredMimeCompatible(spec("a.md"), "")).toBe(true);
    expect(isDeclaredMimeCompatible(spec("a.md"), "application/octet-stream")).toBe(true);
    expect(isDeclaredMimeCompatible(spec("a.csv"), "application/vnd.ms-excel")).toBe(true);
    expect(isDeclaredMimeCompatible(spec("a.txt"), "text/plain; charset=utf-8")).toBe(true);
  });

  it("rejects a declared type that contradicts the extension", () => {
    expect(isDeclaredMimeCompatible(spec("a.png"), "application/pdf")).toBe(false);
    expect(
      code(() => precheckFile({ name: "a.pdf", size: 10, type: "text/html" }, limits)),
    ).toBe("mismatch");
  });
});

describe("content sniffing", () => {
  const check = (name: string, head: Uint8Array) =>
    code(() => verifyContent(name, formatForFileName(name)!, head));

  it("accepts real signatures", () => {
    expect(check("a.pdf", text("%PDF-1.7\n"))).toBeUndefined();
    expect(check("a.docx", bytes(0x50, 0x4b, 0x03, 0x04, 0))).toBeUndefined();
    expect(check("a.png", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBeUndefined();
    expect(check("a.jpg", bytes(0xff, 0xd8, 0xff, 0xe0))).toBeUndefined();
    expect(check("a.gif", text("GIF89a...."))).toBeUndefined();
    expect(check("a.webp", text("RIFF\0\0\0\0WEBPVP8 "))).toBeUndefined();
    expect(check("a.bmp", new Uint8Array([0x42, 0x4d, ...new Array(30).fill(0)]))).toBeUndefined();
    expect(check("a.svg", text('<?xml version="1.0"?>\n<svg xmlns="x"></svg>'))).toBeUndefined();
    expect(check("a.md", text("# Title\nsome %PDF- mention"))).toBeUndefined();
  });

  it("rejects mismatched content", () => {
    expect(check("a.png", bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("mismatch");
    expect(check("a.pdf", text("hello"))).toBe("mismatch");
    expect(check("a.docx", text("%PDF-1.4"))).toBe("mismatch");
    expect(check("a.txt", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("mismatch");
    expect(check("a.csv", bytes(0x61, 0x00, 0x62))).toBe("mismatch");
    expect(check("a.svg", text("<html><body></body></html>"))).toBe("mismatch");
  });
});

describe("sanitizeFileName", () => {
  it("strips paths, control and bidi characters", () => {
    expect(sanitizeFileName("../../etc/passwd.txt")).toBe("passwd.txt");
    expect(sanitizeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("evil\u202Etxt.exe")).toBe("eviltxt.exe");
    expect(sanitizeFileName("a\u0000b\nc.md")).toBe("abc.md");
  });

  it("replaces reserved characters and trims dots/spaces", () => {
    expect(sanitizeFileName('my "file" <1>.csv')).toBe("my _file_ _1_.csv");
    expect(sanitizeFileName("...hidden.txt")).toBe("hidden.txt");
    expect(sanitizeFileName("name.txt.  ")).toBe("name.txt");
    expect(sanitizeFileName("")).toBe("attachment");
  });

  it("caps long names but keeps the extension", () => {
    const out = sanitizeFileName(`${"x".repeat(500)}.docx`);
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith(".docx")).toBe(true);
  });
});

describe("size and count limits", () => {
  it("rejects empty and oversized files", () => {
    expect(code(() => precheckFile({ name: "a.txt", size: 0, type: "" }, limits))).toBe("empty");
    expect(
      code(() => precheckFile({ name: "a.txt", size: limits.maxFileBytes + 1, type: "" }, limits)),
    ).toBe("too-large");
    expect(
      code(() => precheckFile({ name: "a.txt", size: limits.maxFileBytes, type: "" }, limits)),
    ).toBeUndefined();
  });

  it("enforces count and total size for the selection", () => {
    const small = { ...limits, maxFiles: 2, maxTotalBytes: 100 };
    expect(code(() => checkSelectionLimits({ count: 1, totalBytes: 10 }, { name: "a", size: 10 }, small))).toBeUndefined();
    expect(code(() => checkSelectionLimits({ count: 2, totalBytes: 10 }, { name: "a", size: 10 }, small))).toBe("too-many");
    expect(code(() => checkSelectionLimits({ count: 1, totalBytes: 95 }, { name: "a", size: 10 }, small))).toBe("total-too-large");
  });

  it("reads limit overrides from env and ignores invalid values", () => {
    const l = resolveAttachmentLimits({
      VITE_ATTACHMENT_MAX_FILE_MB: "2",
      VITE_ATTACHMENT_MAX_FILES: "3",
      VITE_ATTACHMENT_MAX_TOTAL_MB: "nope",
      VITE_ATTACHMENT_MAX_TEXT_CHARS: "-5",
    });
    expect(l.maxFileBytes).toBe(2 * 1024 * 1024);
    expect(l.maxFiles).toBe(3);
    expect(l.maxTotalBytes).toBe(BASE_ATTACHMENT_LIMITS.maxTotalBytes);
    expect(l.maxTextChars).toBe(BASE_ATTACHMENT_LIMITS.maxTextChars);
  });
});
