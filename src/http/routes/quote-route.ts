import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import type { ClockPort } from "../../application/ports/clock-port";
import type { DocumentIssuancePort } from "../../application/quote/ports/document-issuance-port";
import type { QuoteService } from "../../application/quote/quote-service";
import {
  ACTOR_TYPES,
  DOMAIN_LIMITS,
  QUOTE_LINE_TYPES,
  QUOTE_STATUSES,
  SOURCE_SYSTEMS
} from "../../domain";
import type { AppEnv } from "../../infrastructure/config/env";
import type { QuoteDocumentAccessService } from "../../infrastructure/documents/document-access-service";
import { HttpError, createValidationError } from "../errors";
import {
  toPublicQuoteAuditListDto,
  toPublicQuoteDto,
  toPublicQuoteListDto
} from "../quote-presenter";
import { assertServiceAuthentication } from "../service-auth";

const UUID_SCHEMA = z.uuid();
const QUOTE_NUMBER_PATTERN = /^[A-Za-z0-9._/-]+$/;
const DECIMAL_STRING_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/;

const actorSchema = z.object({
  type: z.enum(ACTOR_TYPES),
  id: z.string().trim().min(1).max(DOMAIN_LIMITS.actor.maxActorIdLength)
});

const expireActorSchema = z.object({
  type: z.enum(["system", "service"]),
  id: z.string().trim().min(1).max(DOMAIN_LIMITS.actor.maxActorIdLength)
});

const sourceSchema = z.object({
  system: z.enum(SOURCE_SYSTEMS),
  correlationId: z.string().trim().max(DOMAIN_LIMITS.source.maxCorrelationIdLength).nullish()
});

const customerSnapshotSchema = z.object({
  name: z.string().trim().min(1).max(DOMAIN_LIMITS.customer.maxNameLength),
  businessName: z.string().trim().max(DOMAIN_LIMITS.customer.maxBusinessNameLength).nullish(),
  email: z.string().trim().max(DOMAIN_LIMITS.customer.maxEmailLength).nullish(),
  phone: z.string().trim().max(DOMAIN_LIMITS.customer.maxPhoneLength).nullish(),
  address: z.string().trim().max(DOMAIN_LIMITS.customer.maxAddressLength).nullish(),
  district: z.string().trim().max(DOMAIN_LIMITS.customer.maxDistrictLength).nullish(),
  region: z.string().trim().max(DOMAIN_LIMITS.customer.maxRegionLength).nullish()
});

const itemSchema = z.object({
  type: z.enum(QUOTE_LINE_TYPES),
  externalItemId: z
    .string()
    .trim()
    .max(DOMAIN_LIMITS.quoteLine.maxExternalItemIdLength)
    .nullish(),
  sku: z.string().trim().max(DOMAIN_LIMITS.quoteLine.maxSkuLength).nullish(),
  description: z.string().trim().min(1).max(DOMAIN_LIMITS.quoteLine.maxDescriptionLength),
  quantity: z.string().regex(DECIMAL_STRING_PATTERN),
  unitPrice: z.string().regex(DECIMAL_STRING_PATTERN),
  taxIncluded: z.boolean(),
  taxRate: z.string().regex(DECIMAL_STRING_PATTERN)
});

const createQuoteBodySchema = z.object({
  opportunityId: z.string().trim().min(1).max(DOMAIN_LIMITS.references.maxReferenceIdLength),
  customerId: z.string().trim().max(DOMAIN_LIMITS.references.maxReferenceIdLength).nullish(),
  conversationId: z
    .string()
    .trim()
    .max(DOMAIN_LIMITS.references.maxReferenceIdLength)
    .nullish(),
  actor: actorSchema,
  source: sourceSchema,
  currency: z.literal("CLP"),
  customerSnapshot: customerSnapshotSchema,
  items: z.array(itemSchema).min(1).max(DOMAIN_LIMITS.quote.maxItems),
  validUntil: z.string().datetime({ offset: true })
});

const updateDraftBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  actor: actorSchema,
  source: sourceSchema,
  customerSnapshot: customerSnapshotSchema,
  items: z.array(itemSchema).min(1).max(DOMAIN_LIMITS.quote.maxItems),
  validUntil: z.string().datetime({ offset: true })
});

const lifecycleBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  actor: actorSchema,
  source: sourceSchema
});

const expireBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  actor: expireActorSchema,
  source: sourceSchema
});

const revisionBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  actor: actorSchema,
  source: sourceSchema,
  newValidUntil: z.string().datetime({ offset: true }).optional()
});

const quoteIdParamsSchema = z.object({
  quoteId: UUID_SCHEMA
});

const quoteNumberParamsSchema = z.object({
  quoteNumber: z.string().trim().min(1).max(DOMAIN_LIMITS.quote.maxQuoteNumberLength).regex(
    QUOTE_NUMBER_PATTERN
  )
});

const listQuotesQuerySchema = z.object({
  opportunityId: z.string().trim().max(DOMAIN_LIMITS.references.maxReferenceIdLength).optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
  revisionRootId: UUID_SCHEMA.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const paginatedAuditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

function requireIdempotencyKey(request: FastifyRequest): string {
  const idempotencyKey = request.headers["idempotency-key"];

  if (typeof idempotencyKey !== "string") {
    throw createValidationError("Idempotency-Key header is required");
  }

  const normalized = idempotencyKey.trim();

  if (normalized.length === 0 || normalized.length > 200) {
    throw createValidationError("Idempotency-Key header is invalid");
  }

  return normalized;
}

function parseSchema<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw createValidationError(message, result.error.issues);
  }

  return result.data;
}

function toSourceInput(input: z.infer<typeof sourceSchema>) {
  return {
    system: input.system,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId ?? null } : {})
  };
}

function toCustomerSnapshotInput(input: z.infer<typeof customerSnapshotSchema>) {
  return {
    name: input.name,
    ...(input.businessName !== undefined ? { businessName: input.businessName ?? null } : {}),
    ...(input.email !== undefined ? { email: input.email ?? null } : {}),
    ...(input.phone !== undefined ? { phone: input.phone ?? null } : {}),
    ...(input.address !== undefined ? { address: input.address ?? null } : {}),
    ...(input.district !== undefined ? { district: input.district ?? null } : {}),
    ...(input.region !== undefined ? { region: input.region ?? null } : {})
  };
}

function toItemInputs(items: readonly z.infer<typeof itemSchema>[]) {
  return items.map((item) => ({
    type: item.type,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    taxIncluded: item.taxIncluded,
    taxRate: item.taxRate,
    ...(item.externalItemId !== undefined
      ? { externalItemId: item.externalItemId ?? null }
      : {}),
    ...(item.sku !== undefined ? { sku: item.sku ?? null } : {})
  }));
}

export function registerQuoteRoute(
  app: FastifyInstance,
  env: AppEnv,
  quoteService: QuoteService,
  clock: ClockPort,
  documentIssuancePort: DocumentIssuancePort,
  documentAccessService: QuoteDocumentAccessService
): void {
  app.register(
    (quoteApp) => {
      quoteApp.addHook("preHandler", (request, _reply, done) => {
        try {
          assertServiceAuthentication(request.headers.authorization, env.SERVICE_AUTH_TOKEN);
          done();
        } catch (error) {
          done(error as Error);
        }
      });

      quoteApp.post("/", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const body = parseSchema(createQuoteBodySchema, request.body, "Invalid create quote body");
        const createdAt = clock.now().toISOString();

        const result = await quoteService.createDraft({
          opportunityId: body.opportunityId,
          ...(body.customerId !== undefined ? { customerId: body.customerId ?? null } : {}),
          ...(body.conversationId !== undefined
            ? { conversationId: body.conversationId ?? null }
            : {}),
          actor: body.actor,
          source: toSourceInput(body.source),
          currency: body.currency,
          customerSnapshot: toCustomerSnapshotInput(body.customerSnapshot),
          items: toItemInputs(body.items),
          validUntil: body.validUntil,
          createdAt,
          idempotencyKey,
          requestHashPayload: {
            operation: "create_draft_quote",
            opportunityId: body.opportunityId,
            customerId: body.customerId ?? null,
            conversationId: body.conversationId ?? null,
            actor: body.actor,
            source: body.source,
            currency: body.currency,
            customerSnapshot: body.customerSnapshot,
            items: body.items,
            validUntil: body.validUntil
          }
        });

        return reply
          .status(201)
          .send(
            toPublicQuoteDto(
              result.quote,
              documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
            )
          );
      });

      quoteApp.get("/by-number/:quoteNumber", async (request, reply) => {
        const params = parseSchema(
          quoteNumberParamsSchema,
          request.params,
          "Invalid quote number parameter"
        );
        const quote = await quoteService.findByQuoteNumber(params.quoteNumber);

        if (!quote) {
          throw new HttpError({
            statusCode: 404,
            code: "quote_not_found",
            message: "Quote not found"
          });
        }

        return reply.send(
          toPublicQuoteDto(
            quote,
            documentAccessService.toPublicIssuedDocument(quote.quoteId, quote.issuedDocument)
          )
        );
      });

      quoteApp.get("/", async (request, reply) => {
        const query = parseSchema(listQuotesQuerySchema, request.query, "Invalid quote list query");
        const result = await quoteService.listQuotes({
          limit: query.limit,
          offset: query.offset,
          ...(query.opportunityId ? { opportunityId: query.opportunityId } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.revisionRootId ? { revisionRootId: query.revisionRootId } : {})
        });

        return reply.send(
          toPublicQuoteListDto(result, (quote) =>
            documentAccessService.toPublicIssuedDocument(quote.quoteId, quote.issuedDocument)
          )
        );
      });

      quoteApp.put("/:quoteId/draft", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(updateDraftBodySchema, request.body, "Invalid update draft body");
        const updatedAt = clock.now().toISOString();

        const result = await quoteService.updateDraft({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          customerSnapshot: toCustomerSnapshotInput(body.customerSnapshot),
          items: toItemInputs(body.items),
          validUntil: body.validUntil,
          updatedAt,
          idempotencyKey,
          requestHashPayload: {
            operation: "update_draft_quote",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source,
            customerSnapshot: body.customerSnapshot,
            items: body.items,
            validUntil: body.validUntil
          }
        });

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/issue", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(lifecycleBodySchema, request.body, "Invalid issue quote body");
        const issuedAt = clock.now().toISOString();

        const result = await quoteService.issueQuoteWithDocuments(
          {
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: toSourceInput(body.source),
            issuedAt,
            idempotencyKey,
            requestHashPayload: {
              operation: "issue_quote",
              quoteId: params.quoteId,
              expectedVersion: body.expectedVersion,
              actor: body.actor,
              source: body.source
            }
          },
          documentIssuancePort
        );

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/accept", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(lifecycleBodySchema, request.body, "Invalid accept quote body");
        const acceptedAt = clock.now().toISOString();

        const result = await quoteService.acceptQuote({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          acceptedAt,
          idempotencyKey,
          requestHashPayload: {
            operation: "accept_quote",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source
          }
        });

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/mark-paid", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(lifecycleBodySchema, request.body, "Invalid mark paid body");
        const paidAt = clock.now().toISOString();

        const result = await quoteService.markQuotePaid({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          paidAt,
          idempotencyKey,
          requestHashPayload: {
            operation: "mark_quote_paid",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source
          }
        });

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/cancel", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(lifecycleBodySchema, request.body, "Invalid cancel quote body");
        const cancelledAt = clock.now().toISOString();

        const result = await quoteService.cancelQuote({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          cancelledAt,
          idempotencyKey,
          requestHashPayload: {
            operation: "cancel_quote",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source
          }
        });

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/expire", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(expireBodySchema, request.body, "Invalid expire quote body");
        const now = clock.now().toISOString();

        const result = await quoteService.expireQuote({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          now,
          idempotencyKey,
          requestHashPayload: {
            operation: "expire_quote",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source
          }
        });

        return reply.send(
          toPublicQuoteDto(
            result.quote,
            documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
          )
        );
      });

      quoteApp.post("/:quoteId/revisions", async (request, reply) => {
        const idempotencyKey = requireIdempotencyKey(request);
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const body = parseSchema(revisionBodySchema, request.body, "Invalid revision body");
        const createdAt = clock.now().toISOString();

        const result = await quoteService.createRevision({
          quoteId: params.quoteId,
          expectedVersion: body.expectedVersion,
          actor: body.actor,
          source: toSourceInput(body.source),
          createdAt,
          ...(body.newValidUntil !== undefined ? { validUntil: body.newValidUntil } : {}),
          idempotencyKey,
          requestHashPayload: {
            operation: "create_quote_revision",
            quoteId: params.quoteId,
            expectedVersion: body.expectedVersion,
            actor: body.actor,
            source: body.source,
            newValidUntil: body.newValidUntil ?? null
          }
        });

        return reply
          .status(201)
          .send(
            toPublicQuoteDto(
              result.quote,
              documentAccessService.toPublicIssuedDocument(result.quote.quoteId, result.quote.issuedDocument)
            )
          );
      });

      quoteApp.get("/:quoteId/documents", async (request, reply) => {
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const quote = await quoteService.findById(params.quoteId);

        if (!quote) {
          throw new HttpError({
            statusCode: 404,
            code: "quote_not_found",
            message: "Quote not found"
          });
        }

        return reply.send(
          documentAccessService.toPublicIssuedDocument(quote.quoteId, quote.issuedDocument)
        );
      });

      quoteApp.get("/:quoteId/audit", async (request, reply) => {
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const query = parseSchema(
          paginatedAuditQuerySchema,
          request.query,
          "Invalid quote audit query"
        );
        const quote = await quoteService.findById(params.quoteId);

        if (!quote) {
          throw new HttpError({
            statusCode: 404,
            code: "quote_not_found",
            message: "Quote not found"
          });
        }

        const auditResult = await quoteService.listAuditEvents({
          quoteId: params.quoteId,
          limit: query.limit,
          offset: query.offset
        });

        return reply.send(toPublicQuoteAuditListDto(auditResult));
      });

      quoteApp.get("/:quoteId", async (request, reply) => {
        const params = parseSchema(quoteIdParamsSchema, request.params, "Invalid quoteId parameter");
        const quote = await quoteService.findById(params.quoteId);

        if (!quote) {
          throw new HttpError({
            statusCode: 404,
            code: "quote_not_found",
            message: "Quote not found"
          });
        }

        return reply.send(
          toPublicQuoteDto(
            quote,
            documentAccessService.toPublicIssuedDocument(quote.quoteId, quote.issuedDocument)
          )
        );
      });
    },
    {
      prefix: "/v1/quotes"
    }
  );
}
