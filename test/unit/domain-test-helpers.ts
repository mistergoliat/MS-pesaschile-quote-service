import { expect } from "vitest";

import { DomainError, type DomainErrorCode } from "../../src/domain";

export function expectDomainError(
  action: () => unknown,
  expectedCode: DomainErrorCode
): void {
  let thrownError: unknown;

  try {
    action();
  } catch (error) {
    thrownError = error;
  }

  expect(thrownError).toBeInstanceOf(DomainError);
  expect((thrownError as DomainError).code).toBe(expectedCode);
}
