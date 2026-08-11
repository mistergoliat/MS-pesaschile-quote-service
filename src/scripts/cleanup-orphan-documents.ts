import "dotenv/config";

import { QuoteService } from "../application/quote/quote-service";
import { loadEnv } from "../infrastructure/config/env";
import { FilesystemDocumentArtifactStorage } from "../infrastructure/documents/filesystem-document-artifact-storage";
import { OrphanDocumentCleanupService } from "../infrastructure/documents/orphan-document-cleanup-service";
import { PostgresDatabase } from "../infrastructure/persistence/postgres/postgres";
import { PostgresQuoteRepository } from "../infrastructure/persistence/postgres/quote-repository";

async function main(): Promise<void> {
  const env = loadEnv();
  const database = new PostgresDatabase(env);
  const storage = new FilesystemDocumentArtifactStorage(env.QUOTE_DOCUMENT_STORAGE_ROOT);
  const repository = new PostgresQuoteRepository(database);
  const quoteService = new QuoteService(repository);
  const cleanupService = new OrphanDocumentCleanupService(storage, quoteService);

  try {
    const result = await cleanupService.cleanupOrphans({
      now: new Date().toISOString(),
      minAgeMs: env.QUOTE_DOCUMENT_ORPHAN_MIN_AGE_MS
    });
    console.log(`Deleted ${result.deletedCount} orphaned document artifact(s).`);
  } finally {
    await database.close();
  }
}

void main();
