import type { AppEnv } from "../config/env";
import type { PostgresDatabase } from "../persistence/postgres/postgres";
import type { FilesystemDocumentArtifactStorage } from "../documents/filesystem-document-artifact-storage";
import type { PuppeteerPdfRenderer } from "../documents/puppeteer-pdf-renderer";

export class StartupValidator {
  constructor(
    private readonly env: AppEnv,
    private readonly database: PostgresDatabase,
    private readonly storage: FilesystemDocumentArtifactStorage,
    private readonly pdfRenderer: PuppeteerPdfRenderer
  ) {}

  async validate(): Promise<void> {
    await this.validateDatabase();
    await this.validateStorage();
    await this.validatePdfRenderer();
  }

  private async validateDatabase(): Promise<void> {
    const database = await this.database.checkHealth(this.env.HEALTHCHECK_DATABASE_TIMEOUT_MS);

    if (database.status !== "up") {
      throw new Error("Database is not reachable during startup validation");
    }
  }

  private async validateStorage(): Promise<void> {
    const storage = await this.storage.checkReadiness();

    if (storage.status !== "up") {
      throw new Error(
        `Document storage is not writable during startup validation: ${storage.details ?? "unknown error"}`
      );
    }
  }

  private async validatePdfRenderer(): Promise<void> {
    const pdfRenderer = await this.pdfRenderer.checkReadiness();

    if (pdfRenderer.status !== "up") {
      throw new Error(
        `PDF renderer is not ready during startup validation: ${pdfRenderer.details ?? "unknown error"}`
      );
    }
  }
}
