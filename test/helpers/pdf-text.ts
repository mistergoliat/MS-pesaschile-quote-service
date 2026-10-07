/**
 * Test-only PDF inspection with pdfjs-dist: the text a reader extracts from
 * the rendered bytes (through the embedded fonts' ToUnicode maps) and the
 * document info dictionary. Used to prove characters survive rendering,
 * which "render() did not throw" cannot.
 */
interface TextItem {
  readonly str?: string;
}

interface PdfjsModule {
  getDocument(source: { data: Uint8Array; disableFontFace: boolean; useSystemFonts: boolean; isEvalSupported: boolean }): {
    promise: Promise<{
      numPages: number;
      getPage(page: number): Promise<{ getTextContent(): Promise<{ items: TextItem[] }> }>;
      getMetadata(): Promise<{ info: Record<string, unknown> }>;
      destroy(): Promise<void>;
    }>;
  };
}

async function open(pdf: Buffer) {
  const pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsModule;
  return pdfjs.getDocument({ data: new Uint8Array(pdf), disableFontFace: true, useSystemFonts: false, isEvalSupported: false }).promise;
}

/** Every page's text items concatenated, in reading order. */
export async function extractPdfText(pdf: Buffer): Promise<string> {
  const document = await open(pdf);

  try {
    const pages: string[] = [];

    for (let page = 1; page <= document.numPages; page += 1) {
      const content = await (await document.getPage(page)).getTextContent();
      pages.push(content.items.map((item) => item.str ?? "").join(""));
    }

    return pages.join("\n");
  } finally {
    await document.destroy();
  }
}

export async function pdfInfo(pdf: Buffer): Promise<{ info: Record<string, unknown>; pages: number }> {
  const document = await open(pdf);

  try {
    return { info: (await document.getMetadata()).info, pages: document.numPages };
  } finally {
    await document.destroy();
  }
}

/** Whitespace-insensitive form for comparing extracted text with logical input. */
export const compact = (value: string): string => value.replace(/\s+/g, "");
