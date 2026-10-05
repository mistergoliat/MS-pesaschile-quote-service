import "dotenv/config";

import { Client } from "pg";
import { z } from "zod";

import { describeConfigError, loadMigrationEnv } from "../infrastructure/config/env";
import { verifyDocumentArtifacts } from "../infrastructure/documents/document-artifact-verifier";
import { FilesystemDocumentArtifactStorage } from "../infrastructure/documents/filesystem-document-artifact-storage";

// Operator check: every document manifest against its stored bytes. Read-only
// unless --record-byte-length is given (records verified legacy V1 sizes).
// Exit 0 when every artifact verifies, 2 when any is missing or altered.
async function main(): Promise<void> {
  const env = loadMigrationEnv();
  const storageRoot = z.string().min(1).parse(process.env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();

  try {
    const report = await verifyDocumentArtifacts({
      database: client,
      storage: new FilesystemDocumentArtifactStorage(storageRoot),
      recordLegacyByteLength: process.argv.includes("--record-byte-length")
    });

    console.log(JSON.stringify({ status: report.problems.length === 0 ? "ok" : "exceptions", ...report }, null, 2));
    process.exitCode = report.problems.length === 0 ? 0 : 2;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const configError = describeConfigError(error);
  console.error(
    JSON.stringify(
      configError
        ? { status: "config_invalid", ...configError }
        : { status: "failed", errorName: error instanceof Error ? error.name : "unknown" }
    )
  );
  process.exit(1);
});
