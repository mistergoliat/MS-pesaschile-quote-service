import "dotenv/config";

import { Client } from "pg";
import { z } from "zod";

import { describeConfigError, loadMigrationEnv } from "../infrastructure/config/env";
import { FilesystemContentAddressedArtifactStore } from "../infrastructure/documents/content-addressed-artifact-store";
import { verifyDocumentArtifacts } from "../infrastructure/documents/document-artifact-verifier";

// Operator integrity check (R1.5B4): every committed document manifest (V2
// and migrated V1) against its stored bytes, with the document endpoint's
// verified read. Detection only: nothing is repaired, regenerated, moved or
// deleted. Read-only unless --record-byte-length is given (records verified
// legacy V1 sizes once; V2 manifests are never written).
// Exit 0 when every artifact verifies, 2 when any is MISSING / HASH_MISMATCH /
// LENGTH_MISMATCH / READ_FAILED / KEY_INVALID / OVERSIZED, 1 when the check
// itself could not run.
async function main(): Promise<void> {
  const env = loadMigrationEnv();
  const storageRoot = z.string().min(1).parse(process.env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const client = new Client({ connectionString: env.databaseUrl });
  await client.connect();

  try {
    const report = await verifyDocumentArtifacts({
      database: client,
      store: new FilesystemContentAddressedArtifactStore(storageRoot),
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
