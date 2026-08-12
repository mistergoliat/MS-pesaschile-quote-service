import { describe, expect, it, vi } from "vitest";

import {
  GmailEmailSender,
  buildGmailMimeMessage,
  encodeBase64Url
} from "../../src/infrastructure/email/gmail-email-sender";

function decodeBase64UrlToUtf8(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

describe("GmailEmailSender", () => {
  it("wires OAuth, builds MIME, includes HTML/PDF, and returns Gmail message id", async () => {
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

    const result = await sender.send({
      to: "customer@example.com",
      from: {
        address: "quotes@pesaschile.cl",
        name: "Pesas Chile"
      },
      replyTo: "reply@pesaschile.cl",
      subject: "Cotizacion Pesas Chile PC-000123",
      html: "<p>Hola cliente</p>",
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
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
    const tokenRequestBody = fetchMock.mock.calls[0]?.[1]?.body;

    expect(typeof tokenRequestBody).toBe("string");
    expect(tokenRequestBody).toContain("grant_type=refresh_token");
    expect(tokenRequestBody).toContain("client_id=gmail-client-id");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "Content-Type": "application/json"
    });

    const sendRequestBody = fetchMock.mock.calls[1]?.[1]?.body;

    expect(typeof sendRequestBody).toBe("string");

    const sendPayload = JSON.parse(sendRequestBody) as {
      readonly raw: string;
    };
    const mimeMessage = decodeBase64UrlToUtf8(sendPayload.raw);

    expect(sendPayload.raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(sendPayload.raw).not.toContain("=");
    expect(mimeMessage).toContain('From: "Pesas Chile" <quotes@pesaschile.cl>');
    expect(mimeMessage).toContain("To: <customer@example.com>");
    expect(mimeMessage).toContain("Reply-To: <reply@pesaschile.cl>");
    expect(mimeMessage).toContain("Subject: Cotizacion Pesas Chile PC-000123");
    expect(mimeMessage).toContain('Content-Type: multipart/mixed; boundary="quote-email-');
    expect(mimeMessage).toContain(
      Buffer.from("<p>Hola cliente</p>", "utf8").toString("base64")
    );
    expect(mimeMessage).toContain(pdfBytes.toString("base64"));
    expect(mimeMessage).toContain('filename="Cotizacion-PC-000123.pdf"');
  });

  it("builds base64url-safe payloads", () => {
    const encoded = encodeBase64Url(buildGmailMimeMessage({
      to: "customer@example.com",
      from: {
        address: "quotes@pesaschile.cl",
        name: "Pesas Chile"
      },
      subject: "Cotizacion Pesas Chile PC-000123",
      html: "<p>Body</p>",
      attachments: []
    }));

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain("=");
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
