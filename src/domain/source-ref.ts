import { DOMAIN_LIMITS, SOURCE_SYSTEMS } from "./constants";
import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import { isClosedEnumValue, normalizeOptionalText } from "./shared";

export type SourceSystem = (typeof SOURCE_SYSTEMS)[number];

export interface SourceRefInput {
  readonly system: SourceSystem;
  readonly correlationId?: string | null;
}

export interface SourceRefState {
  readonly system: SourceSystem;
  readonly correlationId: string | null;
}

export class SourceRef {
  readonly #state: SourceRefState;

  private constructor(state: SourceRefState) {
    this.#state = state;
  }

  static create(input: SourceRefInput): SourceRef {
    if (!isClosedEnumValue(SOURCE_SYSTEMS, input.system)) {
      throw new DomainError(
        DOMAIN_ERROR_CODES.invalidSource,
        "source.system is invalid",
        {
          field: "source.system"
        }
      );
    }

    return new SourceRef({
      system: input.system,
      correlationId: normalizeOptionalText(input.correlationId, {
        field: "source.correlationId",
        code: DOMAIN_ERROR_CODES.invalidSource,
        maxLength: DOMAIN_LIMITS.source.maxCorrelationIdLength
      })
    });
  }

  toSnapshot(): SourceRefState {
    return {
      ...this.#state
    };
  }
}
