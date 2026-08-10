import crypto from "node:crypto";

import { z } from "zod";

export type PublicDocumentArtifactType = "pdf" | "html";

export interface PublicDocumentReferencePayload {
  readonly quoteId: string;
  readonly artifactType: PublicDocumentArtifactType;
  readonly contentHash: string;
}

const decodedPayloadSchema = z.object({
  v: z.literal(1),
  q: z.uuid(),
  t: z.enum(["pdf", "html"]),
  c: z.string().min(1).max(128)
});

export class DocumentReferenceCodec {
  constructor(private readonly secret: string) {}

  encode(input: PublicDocumentReferencePayload): string {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        q: input.quoteId,
        t: input.artifactType,
        c: input.contentHash
      }),
      "utf8"
    ).toString("base64url");
    const signature = crypto.createHmac("sha256", this.secret).update(payload).digest("base64url");

    return `doc_${payload}.${signature}`;
  }

  decode(documentRef: string): PublicDocumentReferencePayload | null {
    if (!documentRef.startsWith("doc_")) {
      return null;
    }

    const raw = documentRef.slice(4);
    const separatorIndex = raw.lastIndexOf(".");

    if (separatorIndex <= 0 || separatorIndex >= raw.length - 1) {
      return null;
    }

    const payload = raw.slice(0, separatorIndex);
    const signature = raw.slice(separatorIndex + 1);
    const expectedSignature = crypto
      .createHmac("sha256", this.secret)
      .update(payload)
      .digest("base64url");
    const actualBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expectedSignature, "utf8");

    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      return null;
    }

    try {
      const decoded = decodedPayloadSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
      );

      return {
        quoteId: decoded.q,
        artifactType: decoded.t,
        contentHash: decoded.c
      };
    } catch {
      return null;
    }
  }
}
