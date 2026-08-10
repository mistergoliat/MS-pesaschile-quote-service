import crypto from "node:crypto";

import { HttpError } from "./errors";

export function assertServiceAuthentication(
  authorizationHeader: unknown,
  expectedToken: string
): void {
  if (typeof authorizationHeader !== "string" || authorizationHeader.trim().length === 0) {
    throw new HttpError({
      statusCode: 401,
      code: "missing_authentication",
      message: "Authentication is required"
    });
  }

  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);

  if (!match || !match[1]) {
    throw new HttpError({
      statusCode: 401,
      code: "invalid_authentication",
      message: "Authentication is invalid"
    });
  }

  const actualToken = Buffer.from(match[1], "utf8");
  const expected = Buffer.from(expectedToken, "utf8");

  if (actualToken.length !== expected.length || !crypto.timingSafeEqual(actualToken, expected)) {
    throw new HttpError({
      statusCode: 401,
      code: "invalid_authentication",
      message: "Authentication is invalid"
    });
  }
}
