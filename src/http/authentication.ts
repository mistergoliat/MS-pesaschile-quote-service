import type { FastifyInstance, FastifyRequest, preHandlerHookHandler } from "fastify";

import { hasScope, type AuthenticatedPrincipal, type QuoteScope } from "../application/auth/principal";
import type { PrincipalRegistry } from "../infrastructure/auth/principal-registry";
import { HttpError } from "./errors";

declare module "fastify" {
  interface FastifyRequest {
    /** Server-resolved principal; null until authenticated. Never read from the request body. */
    principal: AuthenticatedPrincipal | null;
  }

  interface FastifyContextConfig {
    /** Scope the route requires (security contract §2). Mandatory for business routes. */
    requiredScope?: QuoteScope;
  }
}

function unauthenticated(): HttpError {
  return new HttpError({
    statusCode: 401,
    code: "unauthenticated",
    message: "A valid credential is required"
  });
}

function forbidden(requiredScope: QuoteScope): HttpError {
  return new HttpError({
    statusCode: 403,
    code: "forbidden",
    message: "The authenticated principal lacks the required scope",
    details: { requiredScope }
  });
}

/** Resolves the principal from the Authorization header only, or throws 401. */
export function authenticate(registry: PrincipalRegistry, request: FastifyRequest): AuthenticatedPrincipal {
  const principal = registry.authenticate(request.headers.authorization);

  if (principal === null) {
    throw unauthenticated();
  }

  request.principal = principal;
  return principal;
}

/** Throws 403 unless the server-resolved principal holds the scope. */
export function authorize(principal: AuthenticatedPrincipal, scope: QuoteScope): void {
  if (!hasScope(principal, scope)) {
    throw forbidden(scope);
  }
}

/** preHandler for a single route: authenticate (401), then require one scope (403). */
export function requireScope(registry: PrincipalRegistry, scope: QuoteScope): preHandlerHookHandler {
  return (request, _reply, done) => {
    try {
      authorize(authenticate(registry, request), scope);
      done();
    } catch (error) {
      done(error as Error);
    }
  };
}

/**
 * Applies authentication and scope checks to every route of a context.
 * Each route must declare `config.requiredScope`; a route without one fails
 * at registration (startup), so no business route can be left unprotected.
 * Order matches the contract: 401 → 403 before any idempotency lookup.
 */
export function enforceRouteScopes(app: FastifyInstance, registry: PrincipalRegistry): void {
  app.addHook("onRoute", (route) => {
    if (route.config?.requiredScope === undefined) {
      throw new Error(`Business route ${route.method.toString()} ${route.url} declares no requiredScope`);
    }
  });

  app.addHook("preHandler", (request, _reply, done) => {
    try {
      const scope = request.routeOptions.config.requiredScope!;
      authorize(authenticate(registry, request), scope);
      done();
    } catch (error) {
      done(error as Error);
    }
  });
}
