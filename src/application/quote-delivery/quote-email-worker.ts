import { buildQuoteDocumentStorageKeys } from "../../infrastructure/documents/document-paths";
import type { FilesystemDocumentArtifactStorage } from "../../infrastructure/documents/filesystem-document-artifact-storage";
import { QuoteDelivery } from "../../domain";
import type { QuoteAuditEventRecord } from "../quote/ports/quote-repository";
import type { EmailSenderPort } from "./ports/email-sender-port";
import type {
  QuoteEmailDeliveryWorkItem,
  QuoteDeliveryRepository
} from "./ports/quote-delivery-repository";
import { buildQuoteEmailSubject } from "./email-subject";
import { classifyQuoteEmailFailure } from "./retry-policy";

function buildAuditEvent(input: Omit<QuoteAuditEventRecord, "payloadSnapshot"> & {
  readonly payloadSnapshot: Record<string, unknown>;
}): QuoteAuditEventRecord {
  return input;
}

function maskRecipient(recipient: string): string {
  const [localPart, domain] = recipient.split("@");

  if (!localPart || !domain) {
    return "***";
  }

  const visible = localPart.slice(0, Math.min(localPart.length, 2));
  return `${visible}***@${domain}`;
}

export class QuoteEmailWorker {
  constructor(
    private readonly repository: QuoteDeliveryRepository,
    private readonly storage: FilesystemDocumentArtifactStorage,
    private readonly sender: EmailSenderPort,
    private readonly from: {
      readonly address: string;
      readonly name: string;
    },
    private readonly replyTo: string | null,
    private readonly maxAttempts: number
  ) {}

  async runPendingDeliveries(input: {
    readonly now: string;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<{ readonly processedCount: number; readonly deliveryIds: readonly string[] }> {
    const workItems = await this.repository.claimPendingEmailDeliveries(input);
    const processedIds: string[] = [];

    for (const workItem of workItems) {
      await this.processWorkItem(workItem, input.now);
      processedIds.push(workItem.delivery.deliveryId);
    }

    return {
      processedCount: processedIds.length,
      deliveryIds: processedIds
    };
  }

  private async processWorkItem(workItem: QuoteEmailDeliveryWorkItem, now: string): Promise<void> {
    const processingDelivery = QuoteDelivery.rehydrate(workItem.delivery);

    try {
      if (workItem.quote.status !== "issued" && workItem.quote.status !== "accepted") {
        throw new Error(`Quote status ${workItem.quote.status} is not deliverable`);
      }

      if (!workItem.quote.issuedDocument) {
        throw new Error("Quote is missing durable issued document artifacts");
      }

      const documentStorageKeys = buildQuoteDocumentStorageKeys(
        workItem.quote.quoteId,
        workItem.quote.issuedDocument.contentHash,
        workItem.quote.issuedDocument.htmlSha256,
        workItem.quote.issuedDocument.pdfSha256
      );
      const [html, pdf] = await Promise.all([
        this.storage.readBuffer(documentStorageKeys.emailHtmlStorageKey),
        this.storage.readBuffer(workItem.quote.issuedDocument.pdfStorageKey)
      ]);
      const providerResult = await this.sender.send({
        to: workItem.delivery.recipient,
        from: this.from,
        ...(this.replyTo ? { replyTo: this.replyTo } : {}),
        subject: buildQuoteEmailSubject(workItem.quote.quoteNumber),
        html: html.toString("utf8"),
        attachments: [
          {
            filename: `Cotizacion-${workItem.quote.quoteNumber}.pdf`,
            contentType: "application/pdf",
            content: pdf
          }
        ]
      });

      await this.repository.markDeliverySent({
        delivery: processingDelivery.toSnapshot(),
        outbox: workItem.outbox,
        sentAt: now,
        ...(providerResult.providerMessageId !== undefined
          ? { providerMessageId: providerResult.providerMessageId }
          : {}),
        auditEvents: [
          buildAuditEvent({
            quoteId: workItem.quote.quoteId,
            quoteNumber: workItem.quote.quoteNumber,
            action: "email_delivery_sent",
            fromStatus: workItem.quote.status,
            toStatus: workItem.quote.status,
            actorType: workItem.delivery.actor.type,
            actorId: workItem.delivery.actor.id,
            sourceSystem: workItem.delivery.source.system,
            correlationId: workItem.delivery.source.correlationId,
            idempotencyKey: null,
            eventAt: now,
            payloadSnapshot: {
              deliveryId: workItem.delivery.deliveryId,
              attemptCount: workItem.outbox.attemptCount,
              providerMessageId: providerResult.providerMessageId ?? null,
              recipient: maskRecipient(workItem.delivery.recipient)
            }
          })
        ]
      });
    } catch (error) {
      const decision = classifyQuoteEmailFailure({
        error,
        now,
        attemptCount: workItem.outbox.attemptCount,
        maxAttempts: this.maxAttempts
      });

      await this.repository.markDeliveryFailed({
        delivery: processingDelivery.toSnapshot(),
        outbox: workItem.outbox,
        failedAt: now,
        failureCode: decision.failureCode,
        failureMessage: decision.failureMessage,
        retryScheduled: decision.retryable,
        nextAttemptAt: decision.nextAttemptAt,
        auditEvents: [
          buildAuditEvent({
            quoteId: workItem.quote.quoteId,
            quoteNumber: workItem.quote.quoteNumber,
            action: "email_delivery_failed",
            fromStatus: workItem.quote.status,
            toStatus: workItem.quote.status,
            actorType: workItem.delivery.actor.type,
            actorId: workItem.delivery.actor.id,
            sourceSystem: workItem.delivery.source.system,
            correlationId: workItem.delivery.source.correlationId,
            idempotencyKey: null,
            eventAt: now,
            payloadSnapshot: {
              deliveryId: workItem.delivery.deliveryId,
              attemptCount: workItem.outbox.attemptCount,
              failureCode: decision.failureCode,
              recipient: maskRecipient(workItem.delivery.recipient)
            }
          }),
          ...(decision.retryable
            ? [
                buildAuditEvent({
                  quoteId: workItem.quote.quoteId,
                  quoteNumber: workItem.quote.quoteNumber,
                  action: "email_delivery_retry_scheduled",
                  fromStatus: workItem.quote.status,
                  toStatus: workItem.quote.status,
                  actorType: workItem.delivery.actor.type,
                  actorId: workItem.delivery.actor.id,
                  sourceSystem: workItem.delivery.source.system,
                  correlationId: workItem.delivery.source.correlationId,
                  idempotencyKey: null,
                  eventAt: now,
                  payloadSnapshot: {
                    deliveryId: workItem.delivery.deliveryId,
                    attemptCount: workItem.outbox.attemptCount,
                    failureCode: decision.failureCode,
                    nextAttemptAt: decision.nextAttemptAt
                  }
                })
              ]
            : [])
        ]
      });
    }
  }
}
