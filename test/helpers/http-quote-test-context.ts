import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ClockPort } from "../../src/application/ports/clock-port";
import type { AppEnv } from "../../src/infrastructure/config/env";
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

export interface HttpRawResponseSnapshot {
  readonly status: number;
  readonly bodyText: string;
  readonly bodyBuffer: Buffer;
  readonly headers: Headers;
}

export interface CreateHttpQuoteTestContextOptions {
  readonly databaseHandle?: TestDatabaseHandle;
  readonly storageRoot?: string;
  readonly preserveDatabaseOnDispose?: boolean;
  readonly preserveStorageOnDispose?: boolean;
  readonly clock?: IncrementingClock;
  readonly envOverrides?: Partial<AppEnv>;
}

export interface HttpQuoteTestContext {
  readonly databaseHandle: TestDatabaseHandle;
  readonly appContext: ApplicationContext;
  readonly baseUrl: string;
  readonly authToken: string;
  readonly clock: IncrementingClock;
  readonly storageRoot: string;
  request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    auth?: "valid" | "invalid" | "none";
    headers?: Record<string, string>;
  }): Promise<HttpResponseSnapshot<T>>;
  requestRaw(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    auth?: "valid" | "invalid" | "none";
    headers?: Record<string, string>;
  }): Promise<HttpRawResponseSnapshot>;
  dispose(): Promise<void>;
}

export async function createHttpQuoteTestContext(
  options: CreateHttpQuoteTestContextOptions = {}
): Promise<HttpQuoteTestContext> {
  const databaseHandle =
    options.databaseHandle ??
    (await createTestDatabase(process.env.TEST_DATABASE_ADMIN_URL!));
  const authToken = "token";
  const clock = options.clock ?? new IncrementingClock("2026-08-10T18:25:00.000Z");
  const storageRoot =
    options.storageRoot ??
    (await fsPromises.mkdtemp(path.join(os.tmpdir(), "quote-documents-http-")));

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
    HEALTHCHECK_DATABASE_TIMEOUT_MS: 1000,
    QUOTE_COMPANY_NAME: "Pesas Chile SPA",
    QUOTE_DOCUMENT_STORAGE_ROOT: storageRoot,
    QUOTE_DOCUMENT_REF_SECRET: "test-document-secret",
    QUOTE_RENDER_VERSION: "quote-v1",
    QUOTE_PDF_RENDER_TIMEOUT_MS: 15000,
    ...(process.env.QUOTE_PDF_EXECUTABLE_PATH
      ? { QUOTE_PDF_EXECUTABLE_PATH: process.env.QUOTE_PDF_EXECUTABLE_PATH }
      : {}),
    ...options.envOverrides
  } satisfies AppEnv;

  const appContext = buildApplication(env, {
    clock
  });

  const baseUrl = await appContext.app.listen({
    host: env.HOST,
    port: env.PORT
  });

  async function requestRaw(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    auth?: "valid" | "invalid" | "none";
    headers?: Record<string, string>;
  }): Promise<HttpRawResponseSnapshot> {
    const {
      method,
      path: requestPath,
      body,
      auth = "valid",
      headers = {}
    } = input;
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

    const response = await fetch(`${baseUrl}${requestPath}`, requestInit);
    const bodyBuffer = Buffer.from(await response.arrayBuffer());

    return {
      status: response.status,
      bodyText: bodyBuffer.toString("utf8"),
      bodyBuffer,
      headers: response.headers
    };
  }

  async function request<T = unknown>(input: {
    method: "GET" | "POST" | "PUT";
    path: string;
    body?: unknown;
    auth?: "valid" | "invalid" | "none";
    headers?: Record<string, string>;
  }): Promise<HttpResponseSnapshot<T>> {
    const response = await requestRaw(input);

    return {
      status: response.status,
      body: response.bodyText.length > 0 ? (JSON.parse(response.bodyText) as T) : null
    };
  }

  return {
    databaseHandle,
    appContext,
    baseUrl,
    authToken,
    clock,
    storageRoot,
    requestRaw,
    request,
    async dispose() {
      await appContext.app.close();

      if (!options.preserveDatabaseOnDispose) {
        await databaseHandle.dispose();
      }

      if (!options.preserveStorageOnDispose) {
        await fsPromises.rm(storageRoot, {
          recursive: true,
          force: true
        });
      }
    }
  };
}
