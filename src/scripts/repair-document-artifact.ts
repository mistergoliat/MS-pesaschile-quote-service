import "dotenv/config";

import { PrincipalRegistry } from "../infrastructure/auth/principal-registry";
import { loadEnv, principalRegistrySource } from "../infrastructure/config/env";
import { FilesystemContentAddressedArtifactStore } from "../infrastructure/documents/content-addressed-artifact-store";
import { NativePdfRenderer } from "../infrastructure/documents/native-pdf-renderer";
import { repairDocumentArtifact } from "../infrastructure/operator/document-repair";
import { parseOperatorArguments, withOperatorDatabase } from "../infrastructure/operator/operator-plane";
import { runOperatorCommand } from "./operator-command";

// documents:repair (R1.6C): restores the missing bytes of a committed V2
// formal PDF by hash-exact re-rendering from the frozen snapshot. The
// manifest is never written; nothing is published unless the candidate's
// SHA-256 equals the manifest's pdfSha256. Migrated V1 documents are refused.
//   npm run documents:repair -- --quote <uuid> [--document <uuid>] --operator <principalId> [--yes]
// Without --yes: dry run (renders in memory, publishes nothing). Exit 0
// repaired / already intact / dry run would repair, 3 not applicable (no
// document), 2 refused (legacy V1, version, snapshot or hash mismatch,
// integrity conflict, operator principal, invocation, configuration,
// schema), 1 could not run.
runOperatorCommand(async (argv) => {
  const args = parseOperatorArguments(argv, { quote: "uuid", document: "uuid", operator: "principal", yes: "switch" }, ["quote", "operator"]);
  const env = loadEnv();
  const operators = PrincipalRegistry.load(principalRegistrySource(env));

  return withOperatorDatabase(env, (database) =>
    repairDocumentArtifact(
      {
        database,
        store: new FilesystemContentAddressedArtifactStore(env.QUOTE_DOCUMENT_STORAGE_ROOT),
        renderer: new NativePdfRenderer(),
        operators
      },
      { quoteId: args.quote!, documentId: args.document, operatorPrincipalId: args.operator!, confirm: args.yes === true }
    )
  );
});
