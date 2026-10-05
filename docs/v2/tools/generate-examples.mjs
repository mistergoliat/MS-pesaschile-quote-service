// Regenerates docs/v2/examples with the normative integer arithmetic (QUOTE_V2_DOMAIN_CONTRACT.md §6.3).
// Usage: cd docs/v2/tools && npm run generate-examples
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const OUT = fileURLToPath(new URL('../examples', import.meta.url));
mkdirSync(OUT, { recursive: true });
const w = (name, obj) => writeFileSync(`${OUT}/${name}`, JSON.stringify(obj, null, 2) + '\n');
const sha = (s) => createHash('sha256').update(s).digest('hex');
// RFC 8785-compatible canonicalization for the value shapes used here (strings, safe ints, bools, null, arrays, objects).
const jcs = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(jcs).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;

// ---- normative arithmetic (QUOTE_V2_DOMAIN_CONTRACT.md §6) ----
const S = 1000000n;
const scaled = (dec) => { const [i, f = ''] = dec.split('.'); return BigInt(i) * S + BigInt((f + '000000').slice(0, 6)); };
const halfUpDiv = (num, den) => (2n * num + den) / (2n * den); // non-negative operands only
export function charge(unit, qtyDec, basis, rateDec) {
  const ext = halfUpDiv(BigInt(unit) * scaled(qtyDec), S);
  if (basis === 'exempt') return { net: Number(ext), tax: 0, gross: Number(ext) };
  const R = scaled(rateDec);
  if (basis === 'included') { const net = halfUpDiv(ext * S, S + R); return { net: Number(net), tax: Number(ext - net), gross: Number(ext) }; }
  const tax = halfUpDiv(ext * R, S);
  return { net: Number(ext), tax: Number(tax), gross: Number(ext + tax) };
}
function totals(lines, shipping) {
  const all = [...lines.map((l) => ({ a: l.amounts, b: l.unitPrice.taxBasis })), ...(shipping ? [{ a: shipping.amounts, b: shipping.amount.taxBasis }] : [])];
  const s = (k) => all.reduce((x, c) => x + c.a[k], 0);
  return { net: s('net'), tax: s('tax'), gross: s('gross'), exemptNet: all.filter((c) => c.b === 'exempt').reduce((x, c) => x + c.a.net, 0) };
}
const withAmounts = (inputs, ids) => inputs.map((l, i) => ({ lineId: ids[i], position: i + 1, ...l, amounts: charge(l.unitPrice.amount, l.quantity.value, l.unitPrice.taxBasis, l.unitPrice.taxRate) }));
const shipWithAmounts = (s) => ({ ...s, amounts: charge(s.amount.amount, '1', s.amount.taxBasis, s.amount.taxRate) });
function rutDv(n) { let s = 0, m = 2; for (const d of String(n).split('').reverse()) { s += Number(d) * m; m = m === 7 ? 2 : m + 1; } const r = 11 - (s % 11); return r === 11 ? '0' : r === 10 ? 'K' : String(r); }

// ---- customers ----
const person = { kind: 'person', displayName: 'Camila Rojas', email: 'camila.rojas@example.com', phone: '+56 9 1234 5678' };
const company = { kind: 'company', legalName: 'Gimnasio Andes SpA', tradeName: 'Andes Fit', rut: `76123456-${rutDv(76123456)}`, contactName: 'Pedro Soto', email: 'compras@andesfit.example.com', address: { lines: ['Av. Providencia 1234, oficina 501'], commune: 'Providencia', region: 'Región Metropolitana', country: 'CL' } };
w('customer.guest.json', { kind: 'guest' });
w('customer.guest-with-contact.json', { kind: 'guest', displayName: 'Cliente mostrador', phone: '+56 2 2345 6789' });
w('customer.person.json', person);
w('customer.company.json', company);

// ---- transactional flow ----
const corr = { sourceSystem: 'sales-integration', externalReferenceType: 'conversation', externalReference: 'conv-7f3a91c2' };
const requestCorrelationId = 'req-4b1e9d0a-77'; // X-Correlation-Id header of the create request (amendment A3)
const lineInputs = [
  { kind: 'product', item: { sourceSystem: 'pesaschile-catalog', productRef: '1042', variantRef: '3317', sku: 'MH-10', description: 'Mancuerna hexagonal 10 kg', attributes: [{ name: 'Peso', value: '10 kg' }] }, quantity: { value: '2', unit: 'unit' }, unitPrice: { amount: 24990, taxBasis: 'included', taxRate: '0.19' }, pricingProvenance: { sourceSystem: 'pesaschile-catalog', reference: 'price-engine-v2', asOf: '2026-10-04T17:58:12Z' } },
  { kind: 'product', item: { sourceSystem: 'pesaschile-catalog', productRef: '2210', sku: 'BP-200', description: 'Banco plano reforzado' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 89990, taxBasis: 'included', taxRate: '0.19' }, pricingProvenance: { sourceSystem: 'pesaschile-catalog', reference: 'price-engine-v2', asOf: '2026-10-04T17:58:12Z' } },
];
const shippingInput = { carrier: { code: 'starken', name: 'Starken' }, serviceType: { code: 'domicilio', name: 'Entrega a domicilio' }, destination: { commune: 'Ñuñoa', region: 'Región Metropolitana', country: 'CL' }, amount: { amount: 5990, taxBasis: 'excluded', taxRate: '0.19' }, sourceQuote: { sourceSystem: 'pc-carrier', reference: 'all-offers', asOf: '2026-10-04T17:59:40Z' } };
w('shipping.input.json', shippingInput);
const lines = withAmounts(lineInputs, ['5b0c2f3e-8d41-4c7a-9a55-0f2b8e6c1a01', '5b0c2f3e-8d41-4c7a-9a55-0f2b8e6c1a02']);
const shipping = shipWithAmounts(shippingInput);
w('shipping.snapshot.json', shipping);
const tot = totals(lines, shipping);
const createReq = { externalCorrelation: corr, customer: person, lines: lineInputs, shipping: shippingInput, expectedTotals: { net: tot.net, tax: tot.tax, gross: tot.gross } };
w('create-and-issue.request.json', createReq);

const quoteId = '0f8e4a52-3c1b-4d6e-9b7a-2e5f1c8d9a10', opId = 'a3d9c1e7-5b2f-4a8c-8e1d-6f4b2c9e7d30';
const issuedAt = '2026-10-04T18:00:00Z';
const validity = { source: 'policy', policyId: 'cl-retail-5-calendar-days-v1', issuerZone: 'America/Santiago', tzdbVersion: '2025a', issueLocalDate: '2026-10-04', validThroughLocalDate: '2026-10-08', validUntilExclusive: '2026-10-09T03:00:00Z', override: null };
const issuance = { issuedAt, operationId: opId, issuerProfileId: 'pesaschile-cl-v1' };
const snapshot = { quoteId, quoteNumber: 'PC-000137', currency: 'CLP', issuerProfileId: 'pesaschile-cl-v1', issuedAt, validity, customer: person, lines, shipping, totals: tot };
const emptyDoc = { available: false, contentType: 'application/pdf', semanticSnapshotHash: null, pdfSha256: null, byteLength: null, rendererVersion: null, templateVersion: null, generatedAt: null, artifactRef: null };
const pdfSha = sha('example-pdf-bytes:PC-000137');
const doc = { available: true, contentType: 'application/pdf', semanticSnapshotHash: sha(jcs(snapshot)), pdfSha256: pdfSha, byteLength: 18342, rendererVersion: 'quote-pdf-v4', templateVersion: 'quote-template-v4', generatedAt: '2026-10-04T18:00:01.412Z', artifactRef: `sha256:${pdfSha}` };
const baseQuote = { quoteId, status: 'issuing', version: 1, quoteNumber: 'PC-000137', currency: 'CLP', externalCorrelation: corr, customer: person, lines, shipping, totals: tot, validity, issuance, document: emptyDoc, cancellation: null, expiration: null, createdByPrincipalId: 'sales-integration', createdAt: issuedAt, updatedAt: issuedAt };
const issuedQuote = { ...baseQuote, status: 'issued', version: 2, document: doc, updatedAt: '2026-10-04T18:00:01.412Z' };
const opPending = { operationId: opId, type: 'quote.issue', status: 'pending', quoteId, acceptedAt: issuedAt, deadlineAt: '2026-10-05T18:00:00Z', completedAt: null, attempts: { count: 1, lastAttemptAt: '2026-10-04T18:00:00.020Z', lastErrorCode: 'document_storage_failed', nextAttemptAt: '2026-10-04T18:00:05Z' } };
const opDone = { operationId: opId, type: 'quote.issue', status: 'succeeded', quoteId, acceptedAt: issuedAt, deadlineAt: '2026-10-05T18:00:00Z', completedAt: '2026-10-04T18:00:01.412Z', attempts: { count: 1, lastAttemptAt: '2026-10-04T18:00:00.020Z', lastErrorCode: null, nextAttemptAt: null } };
w('create-and-issue.response-201.json', { quote: issuedQuote, operation: opDone });
w('create-and-issue.response-202.json', { quote: baseQuote, operation: opPending });
w('quote-issued.json', issuedQuote);
w('operation-issuing.json', { ...opPending, status: 'running', attempts: { count: 2, lastAttemptAt: '2026-10-04T18:00:05.010Z', lastErrorCode: 'document_storage_failed', nextAttemptAt: null } });
w('quote-list.response.json', { items: [issuedQuote], nextCursor: null });

// ---- manual flow ----
const draftId = 'c41a7e09-2b6d-4f3e-8a1c-9d5e0b7f2a44', dOp = 'e7b2d4f1-9c3a-4e5b-a6d8-1f0c3b5e9a72';
const draftCorr = { sourceSystem: 'backoffice', externalReferenceType: 'case', externalReference: 'CASE-2026-0912' };
const draftLinesIn = [
  { kind: 'product', item: { sourceSystem: 'pesaschile-catalog', productRef: '3301', variantRef: '8810', sku: 'PG-15', description: 'Piso de goma 15 mm', attributes: [{ name: 'Ancho', value: '1 m' }] }, quantity: { value: '12.5', unit: 'm' }, unitPrice: { amount: 18990, taxBasis: 'included', taxRate: '0.19' } },
  { kind: 'service', item: { sourceSystem: 'backoffice', description: 'Servicio exento (ejemplo de cálculo)' }, quantity: { value: '1', unit: 'unit' }, unitPrice: { amount: 35000, taxBasis: 'exempt' } },
];
w('draft-create.request.json', { externalCorrelation: draftCorr, customer: company, lines: draftLinesIn });
const dLines = withAmounts(draftLinesIn, ['91a0e3c4-6f2d-4b8e-a7c5-3e1d9f0b2c11', '91a0e3c4-6f2d-4b8e-a7c5-3e1d9f0b2c12']);
const draft = { quoteId: draftId, status: 'draft', version: 1, quoteNumber: null, currency: 'CLP', externalCorrelation: draftCorr, customer: company, lines: dLines, shipping: null, totals: totals(dLines, null), validity: null, issuance: null, document: emptyDoc, cancellation: null, expiration: null, createdByPrincipalId: 'backoffice', createdAt: '2026-10-04T13:10:00Z', updatedAt: '2026-10-04T13:10:00Z' };
w('draft-create.response-201.json', draft);
const updLines = [{ ...draftLinesIn[0], quantity: { value: '15', unit: 'm' } }, draftLinesIn[1]];
w('draft-update.request.json', { expectedVersion: 1, lines: updLines });
const uLines = withAmounts(updLines, ['2c7e1b90-4d3a-4f6c-8b2e-5a9d0c1f3e21', '2c7e1b90-4d3a-4f6c-8b2e-5a9d0c1f3e22']);
const uTot = totals(uLines, null);
w('issue.request.json', { expectedVersion: 2, expectedTotals: { net: uTot.net, tax: uTot.tax, gross: uTot.gross } });
const dIssuedAt = '2026-10-05T02:30:00Z'; // 23:30 local on 2026-10-04: still civil day 1
const dValidity = { ...validity };
const dSnap = { quoteId: draftId, quoteNumber: 'PC-000138', currency: 'CLP', issuerProfileId: 'pesaschile-cl-v1', issuedAt: dIssuedAt, validity: dValidity, customer: company, lines: uLines, shipping: null, totals: uTot };
const dPdf = sha('example-pdf-bytes:PC-000138');
const dIssued = { ...draft, status: 'issued', version: 4, quoteNumber: 'PC-000138', lines: uLines, totals: uTot, validity: dValidity, issuance: { issuedAt: dIssuedAt, operationId: dOp, issuerProfileId: 'pesaschile-cl-v1' }, document: { ...doc, semanticSnapshotHash: sha(jcs(dSnap)), pdfSha256: dPdf, byteLength: 16120, generatedAt: '2026-10-05T02:30:00.950Z', artifactRef: `sha256:${dPdf}` }, updatedAt: '2026-10-05T02:30:00.950Z' };
w('issue.response-200.json', { quote: dIssued, operation: { operationId: dOp, type: 'quote.issue', status: 'succeeded', quoteId: draftId, acceptedAt: dIssuedAt, deadlineAt: '2026-10-06T02:30:00Z', completedAt: '2026-10-05T02:30:00.950Z', attempts: { count: 1, lastAttemptAt: '2026-10-05T02:30:00.015Z', lastErrorCode: null, nextAttemptAt: null } } });
w('cancel.request.json', { expectedVersion: 2, reasonCode: 'customer_declined' });
w('email-delivery.request.json', { recipient: { email: 'camila.rojas@example.com', name: 'Camila Rojas' } });
w('delivery.response.json', { deliveryId: '7d2f9b1e-3a4c-4e8d-9f0a-6b5c2e1d8a90', quoteId, channel: 'email', status: 'pending', recipientMasked: 'ca***@example.com', documentSha256: pdfSha, requestedAt: '2026-10-04T18:05:00Z', sentAt: null, attempts: { count: 0, lastAttemptAt: null, lastErrorCode: null } });

// ---- idempotency ----
const fp = sha(jcs({ operation: 'quote.create_and_issue', pathParameters: {}, body: createReq }));
w('idempotency-lookup.bound.json', { operation: 'quote.create_and_issue', state: 'bound', binding: { boundAt: issuedAt, requestFingerprint: fp, resourceType: 'quote', quoteId, operationId: opId, deliveryId: null, quoteStatus: 'issued' } });
w('idempotency-lookup.not-found.json', { operation: 'quote.create_and_issue', state: 'not_found', binding: null });
w('audit.response.json', { items: [
  { eventId: 'b1e2c3d4-0001-4a5b-8c6d-7e8f9a0b1c2d', sequence: 1, type: 'quote.issue.accepted', occurredAt: issuedAt, principalId: 'sales-integration', operationId: opId, correlationId: requestCorrelationId, idempotencyKeyHash: sha('example-idempotency-key'), fromStatus: null, toStatus: 'issuing', data: { lineCount: 2, hasShipping: true, gross: tot.gross, validityPolicyId: 'cl-retail-5-calendar-days-v1', quoteNumber: 'PC-000137' } },
  { eventId: 'b1e2c3d4-0002-4a5b-8c6d-7e8f9a0b1c2d', sequence: 2, type: 'quote.issued', occurredAt: '2026-10-04T18:00:01.412Z', principalId: 'system', operationId: opId, correlationId: requestCorrelationId, idempotencyKeyHash: null, fromStatus: 'issuing', toStatus: 'issued', data: { pdfSha256: pdfSha, rendererVersion: 'quote-pdf-v4', templateVersion: 'quote-template-v4', attempts: 1 } },
], nextCursor: null });

// ---- errors ----
const err = (code, message, details) => ({ error: { code, message, requestId: 'req_01J9ZK3M8Q', ...(details ? { details } : {}) } });
w('error.validation.json', err('validation_error', 'Request body is invalid.', { fields: [{ path: '/lines/0/unitPrice/taxRate', code: 'required', message: 'taxRate is required unless taxBasis is exempt.' }, { path: '/customer/rut', code: 'invalid_check_digit', message: 'RUT check digit does not match.' }] }));
w('error.arithmetic-mismatch.json', err('arithmetic_mismatch', 'expectedTotals do not match owner-computed totals.', { expected: { net: tot.net, tax: tot.tax, gross: tot.gross + 1 }, computed: { net: tot.net, tax: tot.tax, gross: tot.gross } }));
w('error.idempotency-key-conflict.json', err('idempotency_key_conflict', 'This Idempotency-Key is already bound to a different request for this operation.', { operation: 'quote.create_and_issue', boundRequestFingerprint: fp }));
w('error.version-conflict.json', err('version_conflict', 'expectedVersion does not match the current quote version.', { expectedVersion: 1, currentVersion: 2 }));
w('error.operation-in-progress.json', err('operation_in_progress', 'The quote is issuing; retry after the operation completes.', { operationId: opId }));
w('error.document-not-available.json', err('document_not_available', 'The quote has no issued document.', { status: 'issuing' }));
w('error.dependency-unavailable.json', err('dependency_unavailable', 'A required dependency is unavailable; nothing was committed.', { dependency: 'database', retryable: true }));
w('error.delivery-recipient-missing.json', err('delivery_recipient_missing', 'No recipient was given and the customer snapshot has no email.'));

// ---- health ----
w('health-live.response.json', { status: 'live' });
w('health-ready.not-ready.json', { status: 'not_ready', checks: { database: 'fail', schema: 'fail', artifactStorage: 'ok', renderer: 'ok', lifecycle: 'ok' } });
w('health-dependencies.response.json', { service: { name: 'pesaschile-quote-service', version: '2.0.0', startedAt: '2026-10-04T12:00:00Z' }, schema: { expectedHead: '000008_quote_v2_runtime_grants', actualHead: null }, dependencies: { database: { status: 'down', failureCategory: 'unreachable', lastSuccessAt: null }, artifactStorage: { status: 'up', failureCategory: null, lastSuccessAt: '2026-10-04T12:00:30Z' }, renderer: { status: 'up', failureCategory: null, lastSuccessAt: '2026-10-04T12:00:01Z' }, emailProvider: { status: 'disabled', failureCategory: null, lastSuccessAt: null } }, workers: { issuance: { enabled: true, lastPollAt: '2026-10-04T12:00:30Z', queueDepth: 0, oldestPendingAgeSeconds: null }, expiry: { enabled: true, lastPollAt: '2026-10-04T12:00:30Z', queueDepth: 0, oldestPendingAgeSeconds: null }, emailDelivery: { enabled: false, lastPollAt: null, queueDepth: 0, oldestPendingAgeSeconds: null } } });

console.log(JSON.stringify({ lines: lines.map((l) => l.amounts), shipping: shipping.amounts, tot, draftLines: dLines.map((l) => l.amounts), draftTot: totals(dLines, null), updLines: uLines.map((l) => l.amounts), uTot, rut: company.rut, fp }));
