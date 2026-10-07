# PostgreSQL transport and safe failure output (R1.7B-S1)

This is a local security/configuration slice. Production readiness remains gated by
the R1.7 pre-flight. It selects no production host, CA, credentials, storage path,
deployment topology, content, or email provider.

| `DATABASE_SSL_MODE` | Behavior | Production (`NODE_ENV=production`) |
| --- | --- | --- |
| `disable` (default) | Plaintext; no TLS | Only URL host `localhost`, `127.0.0.1`, or `::1` |
| `require` | TLS encryption with `rejectUnauthorized=false`; no chain or hostname authentication | Rejected; never sufficient for cross-host production |
| `verify-full` | TLS with certificate chain and configured DNS hostname/IP SAN verification | Accepted with a valid mounted CA certificate file |

The production loopback allowance requires an actual trusted same-host deployment.
A private network or VPC alone is insufficient. DNS and host resolution remain part
of deployment trust; `localhost` must resolve to loopback. Cross-host operation uses
`verify-full`. Legacy `require` retains its previous behavior for development/test.

`DATABASE_SSL_CA_FILE` is mandatory for `verify-full`, including public-CA deployments:
mount the appropriate CA bundle explicitly. There is no implicit fallback to system
trust and no client certificate authentication feature in this slice. The file must
be a regular nonempty PEM bundle of CA certificates, at most 256 KiB, with no extra
text or private keys. Missing, unreadable, malformed, non-CA, or oversized trust
material fails configuration validation before connection. A CA file in another
mode is rejected to prevent misleading configuration. Reads use a fixed bound;
the configured host is verified explicitly even when it is an IP address and pg
does not supply SNI. Mount trust read-only and restart commands/runtime together
when rotating it. This slice does not invent a production CA.

The explicit transport configuration is authoritative. Both selected database URLs
reject case-insensitive query parameters beginning `ssl` or `tls`, plus
`rejectUnauthorized`, `checkServerIdentity`, `servername`, `ca`, `cert`, `key`,
`uselibpqcompat`, `host`, `hostaddr`, `port`, and `connectionString`. This includes
`sslmode`, `sslrootcert`, `sslcert`, `sslkey`, and `sslnegotiation`. It prevents pg's
URL parser from replacing policy or reading certificate paths. PostgreSQL URLs must
use `postgres://` or `postgresql://` with an explicit host; encoded socket hosts and
fragments are rejected. `PGSSLMODE` cannot override the builder's explicit SSL setting.

Runtime pool, dependency probes, and issuance/document operator commands use
`DATABASE_URL`. Explicit `db:migrate`, `db:check`, `db:grants`, and `documents:verify`
select `MIGRATION_DATABASE_URL`, falling back to `DATABASE_URL` for existing local
workflows. They use the same SSL mode, CA file, and production invariant. Migration
credentials never enter the runtime pool or operator path. Tools need database
configuration only; artifact verification additionally needs its storage root.
The synthetic migration rehearsal uses disposable test databases and the same
builder's deliberate default plaintext policy, not production configuration.

Both URLs contain secrets. Principal registry hashes, OAuth credentials, and
document storage are sensitive. A CA certificate is public trust material, but its
integrity is security-critical; its filesystem location is operational information.
No URLs, passwords, certificates, paths, arbitrary error prose, SQL, driver detail,
provider bodies, stack traces, or nested causes are emitted by failure summaries.
Configuration diagnostics contain known setting names and fixed categories only.
Runtime/operator/HTTP/worker failure boundaries share `safeErrorSummary`: allowlisted
names, bounded SQLSTATE or allowlisted OS/TLS codes. Unknown names/codes become
`unknown`/`null`; accessors and custom stringification are not invoked.

The migration CLI retains a fixed tool/phase and SQLSTATE. For 000007's recognized
exception report it extracts the known migration name, count, up to 100 UUID/code
entries, and discards every detail field, including operation names. Other driver
prose is suppressed. Unknown schema names from the database are represented as null
while preserving `SCHEMA_AHEAD_OR_UNKNOWN`. Historical migrations and head 000009
are unchanged.

`.env.example` lists active email lease/poll/token/send timing settings; their existing
startup relationship checks still apply. `QUOTE_COMPANY_NAME` was ignored and has
been removed; issuer content remains code-owned and outside this slice. Email stays
disabled. Replace placeholders through the local secret store rather than shell
history. Do not copy placeholder URLs unchanged or treat this document as deployment
approval.

Validation uses ephemeral OpenSSL-generated CAs and a real disposable PostgreSQL
container. Keys remain inside the fixture volume and are deleted with it. Tests
prove trusted/matching-host success, untrusted/mismatched-host rejection, legacy
require behavior, plaintext behavior, and actual TLS through runtime/operator and
maintenance commands after the fixture rejects all plaintext TCP connections.
The production Docker smoke also uses authenticated TLS and ephemeral trust.
