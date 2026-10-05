# Quote Service V2 Contract

**Status: CONTRACT_FROZEN = YES (R1.2, 2026-10-04).** No V2 runtime exists
yet; implementation follows [QUOTE_V2_ROADMAP.md](QUOTE_V2_ROADMAP.md) (R1.3–R1.7),
each slice separately authorized.

Quote Service V2 issues formal commercial quotes from caller-frozen commercial
snapshots (Model B). It owns quote identity and numbering, the lifecycle, the
immutable issued snapshot, arithmetic verification, validity and expiry, the
issued document, audit, idempotency and reconciliation, and an optional,
explicit email delivery subsystem. It never looks up products, prices, stock or
freight and never sends anything as part of issuing.

| Document | Contents |
|---|---|
| [openapi.yaml](openapi.yaml) | Canonical OpenAPI 3.1 contract (shapes, endpoints, scopes) |
| [QUOTE_V2_DOMAIN_CONTRACT.md](QUOTE_V2_DOMAIN_CONTRACT.md) | Ownership, flows, success evidence, arithmetic, snapshots, document, email, errors, health |
| [QUOTE_V2_STATE_MACHINE.md](QUOTE_V2_STATE_MACHINE.md) | States, transitions, rejected operations, issuance operation states |
| [QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md](QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md) | Keys, fingerprint, bindings, lookup, lease/fencing, crash windows, reconciliation |
| [QUOTE_V2_VALIDITY_POLICY.md](QUOTE_V2_VALIDITY_POLICY.md) | `cl-retail-5-calendar-days-v1`, override, worked DST examples |
| [QUOTE_V2_SECURITY_SCOPES.md](QUOTE_V2_SECURITY_SCOPES.md) | Principals, scopes, visibility, transport and PII rules |
| [QUOTE_V2_V1_MIGRATION.md](QUOTE_V2_V1_MIGRATION.md) | V1 → V2 field mapping; KEEP / CHANGE / DELETE |
| [QUOTE_V2_ROADMAP.md](QUOTE_V2_ROADMAP.md) | R1.3–R1.7 |
| [QUOTE_V2_CONTRACT_FREEZE.md](QUOTE_V2_CONTRACT_FREEZE.md) | Freeze record: decisions, checklist, open items, validation |
| [examples/](examples/) | Request/response/error examples (validated) |
| [tools/](tools/) | Contract validator and example generator (`npm install && npm run validate`) |

Endpoints:

```
POST   /v2/quotes                                   create and issue (201 issued | 202 issuing)
GET    /v2/quotes?sourceSystem=…                    list by external correlation
POST   /v2/quotes/drafts                            create draft
PATCH  /v2/quotes/{quoteId}/draft                   edit draft (expectedVersion)
POST   /v2/quotes/{quoteId}/issue                   issue draft (200 issued | 202 issuing)
GET    /v2/quotes/{quoteId}                         read
POST   /v2/quotes/{quoteId}/cancel                  cancel draft / issued
GET    /v2/quotes/{quoteId}/document                issued PDF bytes
GET    /v2/quotes/{quoteId}/audit                   audit history
POST   /v2/quotes/{quoteId}/deliveries/email        explicit email delivery (provider disabled initially)
GET    /v2/quotes/{quoteId}/deliveries/{deliveryId} delivery state
GET    /v2/operations/{operationId}                 issuance operation
GET    /v2/idempotency/current?operation=…          own key binding lookup
GET    /health/live | /health/ready | /health/dependencies
```

The V1 runtime was retired in R1.4 together with its persistence model
([v2-persistence.md §8](../v2-persistence.md#8-v1-runtime-retirement-owner-decision-r14));
[docs/quote-service-v1-technical-design.md](../quote-service-v1-technical-design.md)
is historical. The V2 API ships in R1.5.
