import "dotenv/config";

import { loadEnv } from "../infrastructure/config/env";
import { listFailedIssuances } from "../infrastructure/operator/failed-issuances";
import { parseOperatorArguments, withOperatorDatabase } from "../infrastructure/operator/operator-plane";
import { runOperatorCommand } from "./operator-command";

// issuance:failed (R1.6C): read-only list of quotes whose current issuance
// operation is `failed` (eligible for issuance:retry). JSON, ids and codes only.
//   npm run issuance:failed -- [--quote <uuid>] [--operation <uuid>] [--error <code>] [--limit <n>]
// Exit 0 listed (also when empty), 1 could not run, 2 refused (invocation,
// configuration, schema not at the expected head).
runOperatorCommand(async (argv) => {
  const args = parseOperatorArguments(argv, { quote: "uuid", operation: "uuid", error: "code", limit: "limit" });
  const env = loadEnv();

  return withOperatorDatabase(env, (database) =>
    listFailedIssuances(database, { quoteId: args.quote, operationId: args.operation, errorCode: args.error, limit: args.limit })
  );
});
