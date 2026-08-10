import { ACTOR_TYPES, DOMAIN_LIMITS } from "./constants";
import { DOMAIN_ERROR_CODES, DomainError } from "./errors";
import { ensureNonEmptyText, isClosedEnumValue } from "./shared";

export type ActorType = (typeof ACTOR_TYPES)[number];

export interface ActorRefInput {
  readonly type: ActorType;
  readonly id: string;
}

export interface ActorRefState {
  readonly type: ActorType;
  readonly id: string;
}

export class ActorRef {
  readonly #state: ActorRefState;

  private constructor(state: ActorRefState) {
    this.#state = state;
  }

  static create(input: ActorRefInput): ActorRef {
    if (!isClosedEnumValue(ACTOR_TYPES, input.type)) {
      throw new DomainError(DOMAIN_ERROR_CODES.invalidActor, "actor.type is invalid", {
        field: "actor.type"
      });
    }

    return new ActorRef({
      type: input.type,
      id: ensureNonEmptyText(input.id, {
        field: "actor.id",
        code: DOMAIN_ERROR_CODES.invalidActor,
        maxLength: DOMAIN_LIMITS.actor.maxActorIdLength
      })
    });
  }

  toSnapshot(): ActorRefState {
    return {
      ...this.#state
    };
  }
}
