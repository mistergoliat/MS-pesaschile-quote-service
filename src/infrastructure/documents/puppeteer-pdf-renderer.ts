import fsPromises from "node:fs/promises";

import puppeteer, { type Browser } from "puppeteer";

import type { DependencyReadinessStatus } from "../../application/health/readiness-service";

const READINESS_CHECK_HTML = "<!doctype html><html><body>renderer-ready</body></html>";
const CHROMIUM_LAUNCH_ARGS = ["--no-sandbox", "--disable-setuid-sandbox"];

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

  async checkReadiness(): Promise<DependencyReadinessStatus> {
    let browser: Browser | null = null;

    try {
      const executablePath = this.resolveExecutablePath();
      await fsPromises.access(executablePath);
      browser = await this.launchBrowser();
      const page = await browser.newPage();

      try {
        await page.setContent(READINESS_CHECK_HTML, {
          waitUntil: "load",
          timeout: this.config.timeoutMs
        });
        await page.pdf({
          format: "A4",
          printBackground: false,
          timeout: this.config.timeoutMs
        });
      } finally {
        await page.close().catch(() => undefined);
      }

      return {
        status: "up"
      };
    } catch (error) {
      return {
        status: "down",
        details: error instanceof Error ? error.message : "pdf renderer is unavailable"
      };
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = this.launchBrowser()
        .catch((error: unknown) => {
          this.browserPromise = null;
          throw error;
        });
    }

    return this.browserPromise;
  }

  private launchBrowser(): Promise<Browser> {
    return puppeteer.launch({
      headless: true,
      args: CHROMIUM_LAUNCH_ARGS,
      timeout: this.config.timeoutMs,
      ...(this.config.executablePath ? { executablePath: this.config.executablePath } : {})
    });
  }

  private resolveExecutablePath(): string {
    return this.config.executablePath ?? puppeteer.executablePath();
  }
}
