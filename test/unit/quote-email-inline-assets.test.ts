import { describe, expect, it } from "vitest";

import {
  QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
  QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID,
  resolveQuoteEmailInlineAssets
} from "../../src/infrastructure/documents/quote-email-inline-assets";

describe("quote email inline assets", () => {
  it("resolves both surface-specific logos as distinct inline PNG attachments", () => {
    const assets = resolveQuoteEmailInlineAssets(
      [
        `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}" />`,
        `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}" />`
      ].join("")
    );

    expect(assets).toHaveLength(2);
    expect(assets.map((asset) => asset.contentId)).toEqual([
      QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID,
      QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID
    ]);
    expect(assets.map((asset) => asset.filename)).toEqual([
      "pesaschile-logo-on-light.png",
      "pesaschile-logo-on-dark.png"
    ]);
    expect(assets.every((asset) => asset.contentType === "image/png")).toBe(true);
    expect(assets.every((asset) => asset.content.length > 0)).toBe(true);
    expect(assets[0]?.content.equals(assets[1]?.content ?? Buffer.alloc(0))).toBe(false);
  });
});
