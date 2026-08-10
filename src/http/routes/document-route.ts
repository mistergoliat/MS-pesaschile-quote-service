import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { QuoteService } from "../../application/quote/quote-service";
import type { AppEnv } from "../../infrastructure/config/env";
import type { QuoteDocumentAccessService } from "../../infrastructure/documents/document-access-service";
import { HttpError } from "../errors";
import { assertServiceAuthentication } from "../service-auth";

const documentRefParamsSchema = z.object({
  documentRef: z.string().trim().min(1).max(512)
});

export function registerDocumentRoute(
  app: FastifyInstance,
  env: AppEnv,
  quoteService: QuoteService,
  documentAccessService: QuoteDocumentAccessService
): void {
  app.register(
    (documentApp) => {
      documentApp.addHook("preHandler", (request, _reply, done) => {
        try {
          assertServiceAuthentication(request.headers.authorization, env.SERVICE_AUTH_TOKEN);
          done();
        } catch (error) {
          done(error as Error);
        }
      });

      documentApp.get("/:documentRef", async (request, reply) => {
        const params = documentRefParamsSchema.parse(request.params);
        const decoded = documentAccessService.decodeDocumentReference(params.documentRef);

        if (!decoded) {
          throw new HttpError({
            statusCode: 404,
            code: "document_not_found",
            message: "Document not found"
          });
        }

        const quote = await quoteService.findById(decoded.quoteId);

        if (!quote || !quote.issuedDocument) {
          throw new HttpError({
            statusCode: 404,
            code: "document_not_found",
            message: "Document not found"
          });
        }

        const resolved = await documentAccessService.resolveDownload(quote, params.documentRef);

        if (!resolved) {
          throw new HttpError({
            statusCode: 404,
            code: "document_not_found",
            message: "Document not found"
          });
        }

        reply.header("Content-Type", resolved.contentType);
        reply.header("Content-Disposition", resolved.contentDisposition);
        reply.header("X-Document-Sha256", resolved.sha256);

        return reply.send(resolved.stream);
      });
    },
    {
      prefix: "/v1/documents"
    }
  );
}
