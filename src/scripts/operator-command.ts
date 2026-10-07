import { PrincipalRegistryError } from "../infrastructure/auth/principal-registry";
import { safeErrorSummary } from "../application/safe-error";
import { describeConfigError } from "../infrastructure/config/env";
import { MigrationManifestError } from "../infrastructure/persistence/postgres/schema-head";
import { OPERATOR_EXIT, OperatorUsageError, type OperatorResult } from "../infrastructure/operator/operator-plane";

/*
 * Process shell of the R1.6C operator commands: argv in, one JSON object on
 * stdout, a stable exit code (operator-plane.ts OPERATOR_EXIT). Failures are
 * reduced to a category: never a stack trace, a driver message, a DSN, a
 * path or a rejected input value.
 */
export function runOperatorCommand(command: (argv: readonly string[]) => Promise<OperatorResult>): void {
  command(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result.body, null, 2)}\n`);
      process.exitCode = result.exitCode;
    },
    (error: unknown) => {
      const configError = describeConfigError(error);
      const [exitCode, body]: [number, Record<string, unknown>] =
        error instanceof OperatorUsageError
          ? [OPERATOR_EXIT.REFUSED, { status: "usage_invalid", message: error.message }]
          : configError
            ? [OPERATOR_EXIT.REFUSED, { status: "config_invalid", ...configError }]
            : error instanceof PrincipalRegistryError
              ? [OPERATOR_EXIT.REFUSED, { status: "principal_registry_invalid", ...safeErrorSummary(error) }]
              : error instanceof MigrationManifestError
                ? [OPERATOR_EXIT.REFUSED, { status: "migration_manifest_invalid" }]
                : [OPERATOR_EXIT.FAILED, { status: "failed", phase: "operator", ...safeErrorSummary(error) }];
      process.stderr.write(`${JSON.stringify(body)}\n`);
      process.exitCode = exitCode;
    }
  );
}
