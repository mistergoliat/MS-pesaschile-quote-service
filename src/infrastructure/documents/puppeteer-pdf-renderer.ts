import puppeteer, { type Browser } from "puppeteer";

export interface PdfRendererPort {
  renderPdf(html: string): Promise<Buffer>;
}

export interface PuppeteerPdfRendererConfig {
  readonly timeoutMs: number;
  readonly executablePath?: string;
}

export class PuppeteerPdfRenderer implements PdfRendererPort {
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: PuppeteerPdfRendererConfig) {}

  async renderPdf(html: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    try {
      await page.setContent(html, {
        waitUntil: "load",
        timeout: this.config.timeoutMs
      });

      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: {
          top: "18mm",
          right: "16mm",
          bottom: "18mm",
          left: "16mm"
        },
        timeout: this.config.timeoutMs
      });

      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (!this.browserPromise) {
      return;
    }

    const browserPromise = this.browserPromise;
    this.browserPromise = null;

    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {
      // Ignore failed launches so app shutdown still completes cleanly.
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = puppeteer
        .launch({
          headless: true,
          ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {})
        })
        .catch((error) => {
          this.browserPromise = null;
          throw error;
        });
    }

    return this.browserPromise;
  }
}
