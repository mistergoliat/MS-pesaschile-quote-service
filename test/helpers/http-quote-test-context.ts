import type { ClockPort } from "../../src/application/ports/clock-port";
import { buildApplication, type ApplicationContext } from "../../src/app";
import { runMigrations } from "../../src/infrastructure/persistence/postgres/migrator";
import {
  createTestDatabase,
  type TestDatabaseHandle
} from "./test-database";

export class IncrementingClock implements ClockPort {
  private currentMs: number;
  private readonly stepMs: number;

  constructor(startIso: string, stepMs = 1_000) {
    this.currentMs = Date.parse(startIso);
    this.stepMs = stepMs;
  }

  now(): Date {
    const current = new Date(this.currentMs);
    this.currentMs += this.stepMs;
    return current;
  }
}

export interface HttpResponseSnapshot<T = unknown> {
  readonly status: number;
  readonly body: T | null;
}

export interface HttpQuoteTestContext {
  readonly databaseHandle: TestDatabaseHandle;
  readonly appContext: ApplicationContext;
  readonly baseUrl: string;
  readonly authToken: string;
  readonly clock: IncrementingClock;
  request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    auth?: "valid" | "invalid" | "none";
    headers?: Record<string, string>;
  }): Promise<HttpResponseSnapshot<T>>;
  dispose(): Promise<void>;
}

export async function createHttpQuoteTestContext(): Promise<HttpQuoteTestContext> {
  const databaseHandle = await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!);
  const authToken = "token";
  const clock = new IncrementingClock("2026-08-10T18:25:00.000Z");

  await runMigrations({
    databaseUrl: databaseHandle.connectionString,
    direction: "up"
  });

  const env = {
    NODE_ENV: "test" as const,
    HOST: "127.0.0.1",
    PORT: 0,
    LOG_LEVEL: "silent" as const,
    DATABASE_URL: databaseHandle.connectionString,
    DATABASE_SSL_MODE: "disable" as const,
    SERVICE_NAME: "pesaschile-quote-service",
    SERVICE_VERSION: "0.1.0-test",
    SERVICE_AUTH_TOKEN: authToken,
    HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000
  };

  const appContext = buildApplication(env, {
    clock
  });

  const baseUrl = await appContext.app.listen({
    host: env.HOST,
    port: env.PORT
  });

  return {
    databaseHandle,
    appContext,
    baseUrl,
    authToken,
    clock,
    async request<T>({
      method,
      path,
      body,
      auth = "valid",
      headers = {}
    }: {
      method: "GET" | "POST" | "PUT";
      path: string;
      body?: unknown;
      auth?: "valid" | "invalid" | "none";
      headers?: Record<string, string>;
    }): Promise<HttpResponseSnapshot<T>> {
      const requestHeaders = new Headers(headers);

      if (auth === "valid") {
        requestHeaders.set("Authorization", `Bearer ${authToken}`);
      } else if (auth === "invalid") {
        requestHeaders.set("Authorization", "Bearer invalid");
      }

      if (body !== undefined) {
        requestHeaders.set("Content-Type", "application/json");
      }

      const requestInit: RequestInit = {
        method,
        headers: requestHeaders
      };

      if (body !== undefined) {
        requestInit.body = JSON.stringify(body);
      }

      const response = await fetch(`${baseUrl}${path}`, requestInit);

      const responseText = await response.text();

      return {
        status: response.status,
        body: responseText.length > 0 ? (JSON.parse(responseText) as T) : null
      };
    },
    async dispose() {
      await appContext.app.close();
      await databaseHandle.dispose();
    }
  };
}
