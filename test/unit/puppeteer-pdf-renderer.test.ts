import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock, executablePathMock } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  executablePathMock: vi.fn(() => "/mock/chrome")
}));

vi.mock("puppeteer", () => ({
  default: {
    launch: launchMock,
    executablePath: executablePathMock
  }
}));

import { PuppeteerPdfRenderer } from "../../src/infrastructure/documents/puppeteer-pdf-renderer";

describe("PuppeteerPdfRenderer", () => {
  beforeEach(() => {
    launchMock.mockReset();
    executablePathMock.mockClear();
  });

  it("launches Chromium with container-safe sandbox flags", async () => {
    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      pdf: vi.fn().mockResolvedValue(Buffer.from("%PDF-smoke")),
      close: vi.fn().mockResolvedValue(undefined)
    };
    const browser = {
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined)
    };
    launchMock.mockResolvedValue(browser);

    const renderer = new PuppeteerPdfRenderer({
      timeoutMs: 1_500,
      executablePath: "/custom/chrome"
    });

    await renderer.renderPdf("<html><body>ok</body></html>");
    await renderer.close();

    expect(launchMock).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/custom/chrome",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 1_500
    });
    expect(page.setContent).toHaveBeenCalled();
    expect(page.pdf).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  });
});
