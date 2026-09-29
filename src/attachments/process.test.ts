import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { BASE_ATTACHMENT_LIMITS } from "./limits";
import { processFile, type ProcessDeps } from "./process";
import { AttachmentError, type AttachmentLimits } from "./types";

const limits: AttachmentLimits = { ...BASE_ATTACHMENT_LIMITS };

function deps(overrides: Partial<ProcessDeps> = {}): ProcessDeps {
  let n = 0;
  return {
    extractPdf: vi.fn(async () => ({ text: "", truncated: false, pageCount: 1 })),
    normalizeImage: vi.fn(async (_name, bytes, spec) => ({ bytes, mimeType: spec.mimeType })),
    newId: () => `id-${++n}`,
    ...overrides,
  };
}

function file(name: string, data: Uint8Array | string, type = ""): File {
  const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return new File([body as BlobPart], name, { type });
}

function zip(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)])));
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof AttachmentError ? e.code : `other:${(e as Error).message}`;
  }
  return "resolved";
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("processFile: text formats", () => {
  it("reads txt/md/csv as text with canonical MIME types", async () => {
    const md = await processFile(file("notes.md", "# Hi\r\nthere", "text/markdown"), limits, deps());
    expect(md).toMatchObject({ format: "md", kind: "document", mimeType: "text/markdown", text: "# Hi\nthere" });
    expect(md.data).toBeUndefined();

    const csv = await processFile(file("d.csv", "a,b\n1,2", "application/vnd.ms-excel"), limits, deps());
    expect(csv).toMatchObject({ format: "csv", mimeType: "text/csv", text: "a,b\n1,2" });
  });

  it("decodes UTF-16 text with a BOM", async () => {
    const utf16 = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const a = await processFile(file("u.txt", utf16), limits, deps());
    expect(a.text).toBe("hi");
  });

  it("rejects invalid UTF-8 and binary masquerading as text", async () => {
    expect(await rejection(processFile(file("a.txt", new Uint8Array([0xc3, 0x28])), limits, deps()))).toBe("mismatch");
    expect(await rejection(processFile(file("a.csv", PNG), limits, deps()))).toBe("mismatch");
  });

  it("truncates long text at maxTextChars", async () => {
    const a = await processFile(file("big.txt", "x".repeat(50)), { ...limits, maxTextChars: 10 }, deps());
    expect(a.text).toBe("x".repeat(10));
    expect(a.truncated).toBe(true);
  });

  it("keeps SVG as text markup without an image payload", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    const a = await processFile(file("logo.svg", svg, "image/svg+xml"), limits, deps());
    expect(a).toMatchObject({ format: "svg", kind: "image", mimeType: "image/svg+xml" });
    expect(a.data).toBeUndefined();
    expect(a.text).toContain("<svg");
  });
});

describe("processFile: Office documents", () => {
  it("extracts docx paragraphs and decodes entities", async () => {
    const bytes = zip({
      "[Content_Types].xml": "<Types/>",
      "word/document.xml":
        '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> &amp; world</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Line</w:t><w:tab/><w:t>two &#x263A;</w:t></w:r></w:p></w:body></w:document>",
    });
    const a = await processFile(file("r.docx", bytes), limits, deps());
    expect(a).toMatchObject({ format: "docx", kind: "document" });
    expect(a.text).toBe("Hello & world\nLine\ttwo \u263A");
  });

  it("extracts pptx slides in presentation order", async () => {
    const bytes = zip({
      "ppt/presentation.xml":
        '<p:presentation><p:sldIdLst><p:sldId id="1" r:id="rId3"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>First file</a:t></a:r></a:p></p:sld>",
      "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Shown first</a:t></a:r></a:p></p:sld>",
    });
    const a = await processFile(file("d.pptx", bytes), limits, deps());
    expect(a.text).toBe("## Slide 1\nShown first\n\n## Slide 2\nFirst file");
  });

  it("extracts xlsx sheets as CSV with shared, inline and boolean cells", async () => {
    const bytes = zip({
      "xl/workbook.xml": '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>Name</t></si><si><r><t>Qty, </t></r><r><t>units</t></r></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="inlineStr"><is><t>Apple</t></is></c><c r="C2"><v>3</v></c><c r="D2" t="b"><v>1</v></c></row>' +
        '<row r="3"/></sheetData></worksheet>',
    });
    const a = await processFile(file("s.xlsx", bytes), limits, deps());
    expect(a.text).toBe('## Sheet: Data\nName,"Qty, units"\nApple,,3,TRUE');
  });

  it("rejects zips that aren't the declared Office type", async () => {
    const notWord = zip({ "xl/workbook.xml": "<workbook/>" });
    expect(await rejection(processFile(file("r.docx", notWord), limits, deps()))).toBe("unreadable");
    const garbage = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]);
    expect(await rejection(processFile(file("r.docx", garbage), limits, deps()))).toBe("unreadable");
  });

  it("bounds decompressed size to defuse zip bombs", async () => {
    const bomb = zip({ "word/document.xml": `<w:t>${"a".repeat(200_000)}</w:t>` });
    expect(bomb.length).toBeLessThan(5_000);
    const code = await rejection(processFile(file("b.docx", bomb), { ...limits, maxArchiveBytes: 100_000 }, deps()));
    expect(code).toBe("too-large");
  });

  it("rejects documents without extractable text", async () => {
    const empty = zip({ "word/document.xml": "<w:document><w:body/></w:document>" });
    expect(await rejection(processFile(file("e.docx", empty), limits, deps()))).toBe("unreadable");
  });
});

describe("processFile: PDFs and images", () => {
  it("keeps PDF bytes for native delivery plus extracted text", async () => {
    const d = deps({
      extractPdf: vi.fn(async () => ({ text: "## Page 1\nHello", truncated: false, pageCount: 1 })),
    });
    const a = await processFile(file("r.pdf", "%PDF-1.7\n...", "application/pdf"), limits, d);
    expect(a).toMatchObject({ format: "pdf", mimeType: "application/pdf", text: "## Page 1\nHello" });
    expect(atob(a.data!)).toBe("%PDF-1.7\n...");
  });

  it("keeps a PDF without text so native-PDF providers can still read it", async () => {
    const a = await processFile(file("scan.pdf", "%PDF-1.4 scanned"), limits, deps());
    expect(a.text).toBeUndefined();
    expect(a.data).toBeTruthy();
  });

  it("encodes images via the normalizer and uses its output MIME type", async () => {
    const normalizeImage = vi.fn(async () => ({ bytes: PNG, mimeType: "image/png" }));
    const bmp = new Uint8Array([0x42, 0x4d, ...new Array(40).fill(0)]);
    const a = await processFile(file("old.bmp", bmp, "image/bmp"), limits, deps({ normalizeImage }));
    expect(normalizeImage).toHaveBeenCalledOnce();
    expect(a).toMatchObject({ format: "bmp", kind: "image", mimeType: "image/png", size: bmp.length });
    expect(a.data).toBe(btoa(String.fromCharCode(...PNG)));
  });

  it("rejects images still over the provider limit after normalization", async () => {
    const small = { ...limits, maxImageBytes: 4 };
    expect(await rejection(processFile(file("a.png", PNG), small, deps()))).toBe("too-large");
  });

  it("rejects mismatched declared types and content", async () => {
    expect(await rejection(processFile(file("a.png", PNG, "image/jpeg"), limits, deps()))).toBe("mismatch");
    expect(await rejection(processFile(file("a.jpg", PNG), limits, deps()))).toBe("mismatch");
  });

  it("sanitizes the file name", async () => {
    const a = await processFile(file("dir/..\u202Eevil.txt", "x"), limits, deps());
    expect(a.name).toBe("evil.txt");
  });
});
