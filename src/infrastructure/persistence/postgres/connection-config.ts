import fs from "node:fs";
import { checkServerIdentity } from "node:tls";
import { X509Certificate } from "node:crypto";

import type { ClientConfig } from "pg";

export interface DatabaseTransportEnv {
  readonly DATABASE_URL: string;
  readonly DATABASE_SSL_MODE?: "disable" | "require" | "verify-full";
  readonly DATABASE_SSL_CA_FILE?: string | undefined;
  readonly NODE_ENV?: string;
  readonly SERVICE_NAME?: string;
}

export class DatabaseTransportConfigError extends Error {
  override readonly name = "DatabaseTransportConfigError";
  constructor(readonly code: string) { super("Invalid database transport configuration"); }
}

const MAX_CA_BYTES = 256 * 1024;

function readCa(file: string): string {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_CA_BYTES) throw new Error();
    // A fixed-size read remains bounded even if the mounted file grows after fstat.
    const buffer = Buffer.alloc(MAX_CA_BYTES + 1);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size === 0 || size > MAX_CA_BYTES) throw new Error();
    const pem = buffer.subarray(0, size).toString("utf8");
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!blocks?.length || pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim() !== "") throw new Error();
    for (const block of blocks) {
      if (!new X509Certificate(block).ca) throw new Error();
    }
    return pem;
  } catch {
    throw new DatabaseTransportConfigError("DB_CA_INVALID");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** Sole owner of transport policy for runtime, probes, and explicit maintenance tools. */
export function buildConnectionConfig(env: DatabaseTransportEnv): ClientConfig {
  let url: URL;
  try {
    url = new URL(env.DATABASE_URL);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.hash) throw new Error();
    // pg decodes the host; percent-encoded hosts could become Unix socket paths.
    if (url.hostname.includes("%")) throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new DatabaseTransportConfigError("DB_URL_INVALID");
  }
  for (const key of url.searchParams.keys()) {
    // pg's URL parser can override SSL and even read arbitrary certificate files.
    // Identity overrides are rejected too: hostname checks must refer to the actual connection host.
    if (/^(?:ssl.*|tls.*|rejectunauthorized|checkserveridentity|servername|ca|cert|key|uselibpqcompat|host|hostaddr|port|connectionstring)$/i.test(key)) {
      throw new DatabaseTransportConfigError("DB_URL_POLICY_CONFLICT");
    }
  }
  const mode = env.DATABASE_SSL_MODE ?? "disable";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (env.NODE_ENV === "production" && (mode === "require" || (mode === "disable" && !["localhost", "127.0.0.1", "::1"].includes(host)))) {
    throw new DatabaseTransportConfigError("DB_PRODUCTION_TRANSPORT_INVALID");
  }
  if (mode !== "verify-full" && env.DATABASE_SSL_CA_FILE !== undefined) throw new DatabaseTransportConfigError("DB_CA_UNUSED");
  if (mode === "verify-full" && !env.DATABASE_SSL_CA_FILE) throw new DatabaseTransportConfigError("DB_CA_REQUIRED");
  // pg's URL parser preserves IPv6 brackets; net.connect requires the unbracketed address.
  // The generated host parameter comes solely from the validated URL, never caller query input.
  if (host.includes(":")) url.searchParams.set("host", host);
  return {
    connectionString: host.includes(":") ? url.href : env.DATABASE_URL,
    ssl: mode === "disable" ? false : mode === "require" ? { rejectUnauthorized: false } : {
      rejectUnauthorized: true,
      ca: readCa(env.DATABASE_SSL_CA_FILE!),
      // pg only supplies SNI for DNS names. Verify IP SANs against the configured IP as well.
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(host, certificate)
    },
    ...(env.SERVICE_NAME === undefined ? {} : { application_name: env.SERVICE_NAME })
  };
}
