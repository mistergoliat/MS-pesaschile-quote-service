export interface EmailAddress {
  readonly address: string;
  readonly name?: string;
}

export interface EmailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Buffer;
}

export interface EmailSenderPort {
  send(input: {
    readonly to: string;
    readonly from: EmailAddress;
    readonly replyTo?: string;
    readonly subject: string;
    readonly html: string;
    readonly attachments: readonly EmailAttachment[];
  }): Promise<{
    readonly providerMessageId?: string;
  }>;
}
