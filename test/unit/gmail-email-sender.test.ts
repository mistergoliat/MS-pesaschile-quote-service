import { describe, expect, it, vi } from "vitest";

import {
  GmailEmailSender,
  buildGmailMimeMessage,
  encodeBase64Url
} from "../../src/infrastructure/email/gmail-email-sender";
import {
  QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
  QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID
} from "../../src/infrastructure/documents/quote-email-inline-assets";

function decodeBase64UrlToUtf8(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

describe("GmailEmailSender", () => {
  it("wires OAuth, builds MIME, includes both inline logos plus HTML/PDF, and returns Gmail message id", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access-token"
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "gmail-message-id-123"
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      );
    const sender = new GmailEmailSender({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
      refreshToken: "gmail-refresh-token",
      user: "quotes@pesaschile.cl",
      fetch: fetchMock
    });
    const pdfBytes = Buffer.from("%PDF-test");
    const html = [
      "<p>Hola cliente</p>",
      `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}" alt="Pesas Chile" />`,
      `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}" alt="Pesas Chile" />`
    ].join("");

    const result = await sender.send({
      to: "customer@example.com",
      from: {
        address: "quotes@pesaschile.cl",
        name: "Pesas Chile"
      },
      replyTo: "reply@pesaschile.cl",
      subject: "Cotizacion Pesas Chile PC-000123",
      html,
      attachments: [
        {
          filename: "Cotizacion-PC-000123.pdf",
          contentType: "application/pdf",
          content: pdfBytes
        }
      ]
    });

    expect(result.providerMessageId).toBe("gmail-message-id-123");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );

    const sendRequestBody = fetchMock.mock.calls[1]?.[1]?.body;

    expect(typeof sendRequestBody).toBe("string");
    if (typeof sendRequestBody !== "string") {
      throw new Error("Expected Gmail send request body to be a string");
    }

    const sendPayload = JSON.parse(sendRequestBody) as {
      readonly raw: string;
    };
    const mimeMessage = decodeBase64UrlToUtf8(sendPayload.raw);

    expect(sendPayload.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sendPayload.raw).not.toContain("=");
    expect(mimeMessage).toContain('Content-Type: multipart/mixed; boundary="quote-email-mixed-');
    expect(mimeMessage).toContain('Content-Type: multipart/related; boundary="quote-email-related-');
    expect(mimeMessage).toContain(`Content-ID: <${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}>`);
    expect(mimeMessage).toContain(`Content-ID: <${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}>`);
    expect(mimeMessage).toContain('Content-Disposition: inline; filename="pesaschile-logo-dark.png"');
    expect(mimeMessage).toContain('Content-Disposition: inline; filename="pesaschile-logo-light.png"');
    expect(mimeMessage).toContain(`X-Attachment-Id: ${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}`);
    expect(mimeMessage).toContain(`X-Attachment-Id: ${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}`);
    expect(mimeMessage).toContain("Content-Location: pesaschile-logo-dark.png");
    expect(mimeMessage).toContain("Content-Location: pesaschile-logo-light.png");
    expect(mimeMessage).not.toContain("pesaschile-symbol");
  });

  it("builds base64url-safe payloads", () => {
    const encoded = encodeBase64Url(
      buildGmailMimeMessage({
        to: "customer@example.com",
        from: {
          address: "quotes@pesaschile.cl",
          name: "Pesas Chile"
        },
        subject: "Cotizacion Pesas Chile PC-000123",
        html: "<p>Body</p>",
        attachments: []
      })
    );

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
  });

  it("builds multipart/related messages when only inline logo assets are present", () => {
    const mimeMessage = buildGmailMimeMessage({
      to: "customer@example.com",
      from: {
        address: "quotes@pesaschile.cl",
        name: "Pesas Chile"
      },
      subject: "Cotizacion Pesas Chile PC-000123",
      html: [
        `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}" alt="Pesas Chile" />`,
        `<img src="cid:${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}" alt="Pesas Chile" />`
      ].join(""),
      attachments: [],
      inlineAssets: [
        {
          contentId: QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID,
          filename: "pesaschile-logo-dark.png",
          contentType: "image/png",
          content: Buffer.from("png-dark", "utf8")
        },
        {
          contentId: QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID,
          filename: "pesaschile-logo-light.png",
          contentType: "image/png",
          content: Buffer.from("png-light", "utf8")
        }
      ]
    });

    expect(mimeMessage).toContain('Content-Type: multipart/related; boundary="quote-email-related-');
    expect(mimeMessage).toContain(`Content-ID: <${QUOTE_EMAIL_INLINE_LOGO_DARK_CONTENT_ID}>`);
    expect(mimeMessage).toContain(`Content-ID: <${QUOTE_EMAIL_INLINE_LOGO_LIGHT_CONTENT_ID}>`);
    expect(mimeMessage).toContain('Content-Disposition: inline; filename="pesaschile-logo-dark.png"');
    expect(mimeMessage).toContain('Content-Disposition: inline; filename="pesaschile-logo-light.png"');
    expect(mimeMessage).not.toContain("pesaschile-symbol");
    expect(mimeMessage).not.toContain('Content-Type: multipart/mixed; boundary="quote-email-mixed-');
  });

  it("classifies Gmail 429 send failures as retryable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 429,
              message: "Rate limit exceeded"
            }
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      );
    const sender = new GmailEmailSender({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
      refreshToken: "gmail-refresh-token",
      user: "quotes@pesaschile.cl",
      fetch: fetchMock
    });

    await expect(
      sender.send({
        to: "customer@example.com",
        from: {
          address: "quotes@pesaschile.cl"
        },
        subject: "Cotizacion Pesas Chile PC-000123",
        html: "<p>Hola</p>",
        attachments: []
      })
    ).rejects.toMatchObject({
      code: "gmail_api_rate_limited",
      retryable: true
    });
  });

  it("classifies Gmail 5xx send failures as retryable", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json"
          }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 503,
              message: "Backend error"
            }
          }),
          {
            status: 503,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
      );
    const sender = new GmailEmailSender({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
      refreshToken: "gmail-refresh-token",
      user: "quotes@pesaschile.cl",
      fetch: fetchMock
    });

    await expect(
      sender.send({
        to: "customer@example.com",
        from: {
          address: "quotes@pesaschile.cl"
        },
        subject: "Cotizacion Pesas Chile PC-000123",
        html: "<p>Hola</p>",
        attachments: []
      })
    ).rejects.toMatchObject({
      code: "gmail_api_server_error",
      retryable: true
    });
  });

  it("classifies invalid_grant auth failures as terminal", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked."
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json"
          }
        }
      )
    );
    const sender = new GmailEmailSender({
      clientId: "gmail-client-id",
      clientSecret: "gmail-client-secret",
      refreshToken: "gmail-refresh-token",
      user: "quotes@pesaschile.cl",
      fetch: fetchMock
    });

    await expect(
      sender.send({
        to: "customer@example.com",
        from: {
          address: "quotes@pesaschile.cl"
        },
        subject: "Cotizacion Pesas Chile PC-000123",
        html: "<p>Hola</p>",
        attachments: []
      })
    ).rejects.toMatchObject({
      code: "gmail_invalid_grant",
      retryable: false
    });
  });
});
