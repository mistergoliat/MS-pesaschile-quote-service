import "dotenv/config";

import { PrincipalRegistry } from "../infrastructure/auth/principal-registry";
import { loadEnv, principalRegistrySource } from "../infrastructure/config/env";
import { retryFailedIssuance } from "../infrastructure/operator/issuance-retry";
import { parseOperatorArguments, withOperatorDatabase } from "../infrastructure/operator/operator-plane";
import { PostgresIssuanceOperationRepository } from "../infrastructure/persistence/postgres/issuance-operations";
import { runOperatorCommand } from "./operator-command";

// issuance:retry (R1.6C): operator retry (T10) of a quote whose current
// issuance operation is `failed`, through the existing state primitive.
//   npm run issuance:retry -- --quote <uuid> --operation <failedOperationId> --operator <principalId> --reason <code> [--yes]
// Without --yes: dry run (reads only). Exit 0 retry created / dry run passed,
// 3 not applicable (state changed, already retried), 2 refused (operator
// principal, snapshot integrity, invocation, configuration, schema), 1 could
// not run (or the commit could not be confirmed and nothing was applied).
runOperatorCommand(async (argv) => {
  const args = parseOperatorArguments(
    argv,
    { quote: "uuid", operation: "uuid", operator: "principal", reason: "code", yes: "switch" },
    ["quote", "operation", "operator", "reason"]
  );
  const env = loadEnv();
  const operators = PrincipalRegistry.load(principalRegistrySource(env));

  return withOperatorDatabase(env, (database) =>
    retryFailedIssuance(
      {
        database,
        repository: new PostgresIssuanceOperationRepository(database, { leaseMs: env.QUOTE_ISSUANCE_LEASE_MS, deadlineMs: env.QUOTE_ISSUANCE_DEADLINE_MS }),
        operators
      },
      {
        quoteId: args.quote!,
        failedOperationId: args.operation!,
        operatorPrincipalId: args.operator!,
        reasonCode: args.reason!,
        confirm: args.yes === true
      }
    )
  );
});
