import { DOMAIN_LIMITS } from "./constants";
import { DOMAIN_ERROR_CODES } from "./errors";
import { ensureNonEmptyText, normalizeOptionalText } from "./shared";

export interface CustomerSnapshotInput {
  readonly name: string;
  readonly businessName?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly address?: string | null;
  readonly district?: string | null;
  readonly region?: string | null;
}

export interface CustomerSnapshotState {
  readonly name: string;
  readonly businessName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly district: string | null;
  readonly region: string | null;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class CustomerSnapshot {
  readonly #state: CustomerSnapshotState;

  private constructor(state: CustomerSnapshotState) {
    this.#state = state;
  }

  static create(input: CustomerSnapshotInput): CustomerSnapshot {
    return new CustomerSnapshot({
      name: ensureNonEmptyText(input.name, {
        field: "customerSnapshot.name",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxNameLength
      }),
      businessName: normalizeOptionalText(input.businessName, {
        field: "customerSnapshot.businessName",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxBusinessNameLength
      }),
      email: normalizeOptionalText(input.email, {
        field: "customerSnapshot.email",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxEmailLength,
        pattern: EMAIL_PATTERN
      }),
      phone: normalizeOptionalText(input.phone, {
        field: "customerSnapshot.phone",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxPhoneLength
      }),
      address: normalizeOptionalText(input.address, {
        field: "customerSnapshot.address",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxAddressLength
      }),
      district: normalizeOptionalText(input.district, {
        field: "customerSnapshot.district",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxDistrictLength
      }),
      region: normalizeOptionalText(input.region, {
        field: "customerSnapshot.region",
        code: DOMAIN_ERROR_CODES.invalidCustomerSnapshot,
        maxLength: DOMAIN_LIMITS.customer.maxRegionLength
      })
    });
  }

  toSnapshot(): CustomerSnapshotState {
    return {
      ...this.#state
    };
  }
}
