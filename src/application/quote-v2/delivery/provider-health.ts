import { EMAIL_DELIVERY_ERROR_CODES as CODES, type MailSendOutcome } from "./mail-sender-port";

/*
 * `emailProvider` status for `/health/dependencies` (frozen DependencyStatus:
 * up | down | degraded | disabled). The provider is NEVER probed and no
 * message is ever sent for health: the status is derived from configuration
 * and from the delivery worker's most recent provider outcome. In-memory
 * observability only (resets on restart); it never affects `/health/ready`
 * and never gates a business route.
 *
 *   no sender configured                 disabled
 *   configured, no outcome yet           up (nothing observed against it)
 *   accepted                             up, lastSuccessAt = now
 *   rejected message (permanent 4xx)     up (the provider answered)
 *   rate limited                         degraded / provider_error
 *   ambiguous (5xx, timeout, reset)      degraded / provider_error
 *   credentials rejected (W5)            down / authentication
 *   unreachable before the send          down / unreachable
 */

export type ProviderStatus = "up" | "down" | "degraded" | "disabled";
export type ProviderFailureCategory = "authentication" | "unreachable" | "provider_error" | null;

export interface ProviderHealthView {
  readonly status: ProviderStatus;
  readonly failureCategory: ProviderFailureCategory;
  readonly lastSuccessAt: string | null;
}

export class ProviderHealthTracker {
  #status: ProviderStatus;
  #failureCategory: ProviderFailureCategory = null;
  #lastSuccessAt: string | null = null;

  constructor(
    configured: boolean,
    private readonly now: () => Date = () => new Date()
  ) {
    this.#status = configured ? "up" : "disabled";
  }

  record(outcome: MailSendOutcome): void {
    if (this.#status === "disabled") {
      return;
    }

    if (outcome.kind === "accepted") {
      this.#set("up", null);
      this.#lastSuccessAt = this.now().toISOString();
      return;
    }

    if (outcome.kind === "ambiguous") {
      this.#set("degraded", "provider_error");
      return;
    }

    switch (outcome.code) {
      case CODES.authenticationFailed:
        this.#set("down", "authentication");
        return;
      case CODES.providerUnavailable:
        this.#set("down", "unreachable");
        return;
      case CODES.rateLimited:
        this.#set("degraded", "provider_error");
        return;
      case CODES.providerRejected:
        this.#set("up", null);
        return;
      default:
        // email_message_invalid: refused before any provider contact; says nothing about the provider.
        return;
    }
  }

  view(): ProviderHealthView {
    return { status: this.#status, failureCategory: this.#failureCategory, lastSuccessAt: this.#lastSuccessAt };
  }

  #set(status: ProviderStatus, failureCategory: ProviderFailureCategory): void {
    this.#status = status;
    this.#failureCategory = failureCategory;
  }
}
