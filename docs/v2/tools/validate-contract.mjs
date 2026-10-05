// Static contract validation for Quote Service V2 (documentation tooling, not a runtime dependency).
// Usage: cd docs/v2/tools && npm install && npm run validate
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const DIR = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };
const doc = YAML.parse(readFileSync(`${DIR}/openapi.yaml`, 'utf8'));
const read = (p) => JSON.parse(readFileSync(`${DIR}/${p}`, 'utf8'));
const text = (p) => readFileSync(`${DIR}/${p}`, 'utf8');

check('openapi version 3.1.0', doc.openapi === '3.1.0');
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(doc, 'oas');
const S = (name) => ajv.getSchema(`oas#/components/schemas/${name}`);

// 1. every component schema compiles (all $refs resolve)
for (const name of Object.keys(doc.components.schemas)) {
  let ok = true, detail = '';
  try { if (!S(name)) { ok = false; detail = 'not found'; } } catch (e) { ok = false; detail = e.message; }
  check(`schema compiles: ${name}`, ok, detail);
}
// all $ref targets exist
const refs = new Set();
(function walk(o) { if (o && typeof o === 'object') { for (const [k, v] of Object.entries(o)) { if (k === '$ref') refs.add(v); else walk(v); } } })(doc);
const resolvePtr = (ref) => ref.replace(/^#\//, '').split('/').reduce((o, k) => (o ? o[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), doc);
for (const r of refs) check(`$ref resolves: ${r}`, resolvePtr(r) !== undefined);

// 2. examples referenced by externalValue validate against their media schema
const validated = new Map();
const validateWith = (schemaRef, file, ctx) => {
  const v = ajv.getSchema(`oas${schemaRef}`);
  const data = read(file);
  const ok = v(data);
  check(`example valid: ${file} vs ${schemaRef.split('/').pop()} (${ctx})`, ok, ok ? '' : JSON.stringify(v.errors.slice(0, 3)));
  validated.set(file, (validated.get(file) ?? 0) + 1);
};
const deref = (o) => (o && o.$ref ? resolvePtr(o.$ref) : o);
const ops = [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    ops.push({ path, method, op });
    const contents = [];
    if (op.requestBody) contents.push(['request', op.requestBody.content]);
    for (const [code, resp] of Object.entries(op.responses ?? {})) contents.push([`response ${code}`, deref(resp).content]);
    for (const [ctx, content] of contents) for (const media of Object.values(content ?? {})) {
      for (const ex of Object.values(media.examples ?? {})) if (ex.externalValue) validateWith(media.schema.$ref, ex.externalValue.replace(/^examples\//, 'examples/'), `${method.toUpperCase()} ${path} ${ctx}`);
    }
  }
}
// 3. standalone examples
const standalone = { 'examples/customer.guest.json': 'Customer', 'examples/customer.guest-with-contact.json': 'Customer', 'examples/customer.person.json': 'Customer', 'examples/customer.company.json': 'Customer', 'examples/shipping.input.json': 'ShippingInput', 'examples/shipping.snapshot.json': 'Shipping', 'examples/draft-update.request.json': 'UpdateDraftRequest', 'examples/cancel.request.json': 'CancelRequest', 'examples/email-delivery.request.json': 'EmailDeliveryRequest' };
for (const [f, s] of Object.entries(standalone)) validateWith(`#/components/schemas/${s}`, f, 'standalone');
for (const f of readdirSync(`${DIR}/examples`)) check(`example covered: ${f}`, validated.has(`examples/${f}`));

// 4. negative cases MUST fail
const createReq = read('examples/create-and-issue.request.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const neg = (name, schema, mutate) => { const d = clone(createReq); const x = mutate(d) ?? d; check(`negative rejected: ${name}`, !S(schema)(x)); };
neg('exempt with taxRate', 'CreateQuoteRequest', (d) => { d.lines[0].unitPrice = { amount: 100, taxBasis: 'exempt', taxRate: '0.19' }; });
neg('included without taxRate', 'CreateQuoteRequest', (d) => { delete d.lines[0].unitPrice.taxRate; });
neg('non-canonical quantity 1.50', 'CreateQuoteRequest', (d) => { d.lines[0].quantity.value = '1.50'; });
neg('zero quantity', 'CreateQuoteRequest', (d) => { d.lines[0].quantity.value = '0'; });
neg('float amount', 'CreateQuoteRequest', (d) => { d.lines[0].unitPrice.amount = 24990.5; });
neg('caller validUntil', 'CreateQuoteRequest', (d) => { d.validUntil = '2026-10-09T03:00:00Z'; });
neg('opportunityId member', 'CreateQuoteRequest', (d) => { d.opportunityId = 'opp-1'; });
neg('reference without type', 'CreateQuoteRequest', (d) => { delete d.externalCorrelation.externalReferenceType; });
neg('empty lines on create', 'CreateQuoteRequest', (d) => { d.lines = []; });
neg('person without displayName', 'CreateQuoteRequest', (d) => { d.customer = { kind: 'person' }; });
neg('company without legalName', 'CreateQuoteRequest', (d) => { d.customer = { kind: 'company', tradeName: 'X' }; });
neg('unknown customer kind', 'CreateQuoteRequest', (d) => { d.customer = { kind: 'anonymous' }; });
neg('shipping destination non-CL', 'CreateQuoteRequest', (d) => { d.shipping.destination.country = 'AR'; });
neg('shipping as description string', 'CreateQuoteRequest', (d) => { d.shipping = 'Despacho Starken'; });
neg('tax rate as number', 'CreateQuoteRequest', (d) => { d.lines[0].unitPrice.taxRate = 0.19; });
neg('rut with dots', 'CreateQuoteRequest', (d) => { d.customer = { kind: 'person', displayName: 'A B', rut: '76.123.456-0' }; });
neg('quote status accepted', 'QuoteStatus', () => 'accepted');
neg('quote status paid', 'QuoteStatus', () => 'paid');
neg('update draft without changes', 'UpdateDraftRequest', () => ({ expectedVersion: 1 }));
check('positive: guest customer minimal', S('Customer')({ kind: 'guest' }));
check('positive: canonical quantities', ['2', '12.5', '0.25', '9999.999999'].every((q) => S('Quantity')(q)));

// 5. semantic checks on examples: arithmetic, totals, validity, success evidence
const SC = 1000000n;
const scaled = (dec) => { const [i, f = ''] = dec.split('.'); return BigInt(i) * SC + BigInt((f + '000000').slice(0, 6)); };
const halfUp = (n, d) => (2n * n + d) / (2n * d);
const charge = (u, q, b, r) => { const ext = halfUp(BigInt(u) * scaled(q), SC); if (b === 'exempt') return { net: Number(ext), tax: 0, gross: Number(ext) }; const R = scaled(r); if (b === 'included') { const n = halfUp(ext * SC, SC + R); return { net: Number(n), tax: Number(ext - n), gross: Number(ext) }; } const t = halfUp(ext * R, SC); return { net: Number(ext), tax: Number(t), gross: Number(ext + t) }; };
const ZONE = 'America/Santiago';
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const civil = (ms) => fmt.format(new Date(ms));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const startOf = (D) => { let lo = Date.parse(D + 'T00:00:00Z') - 14 * 3600e3, hi = Date.parse(D + 'T00:00:00Z') + 14 * 3600e3; while (hi - lo > 1000) { const m = Math.floor((lo + hi) / 2000) * 1000; if (civil(m) >= D) hi = m; else lo = m; } return hi; };
function checkQuote(q, label) {
  for (const l of q.lines) { const c = charge(l.unitPrice.amount, l.quantity.value, l.unitPrice.taxBasis, l.unitPrice.taxRate); check(`${label}: line ${l.position} amounts`, JSON.stringify(c) === JSON.stringify(l.amounts), JSON.stringify({ c, got: l.amounts })); }
  if (q.shipping) { const c = charge(q.shipping.amount.amount, '1', q.shipping.amount.taxBasis, q.shipping.amount.taxRate); check(`${label}: shipping amounts`, JSON.stringify(c) === JSON.stringify(q.shipping.amounts)); }
  const all = [...q.lines.map((l) => [l.amounts, l.unitPrice.taxBasis]), ...(q.shipping ? [[q.shipping.amounts, q.shipping.amount.taxBasis]] : [])];
  const sum = (k) => all.reduce((s, [a]) => s + a[k], 0);
  check(`${label}: totals`, q.totals.net === sum('net') && q.totals.tax === sum('tax') && q.totals.gross === sum('gross') && q.totals.exemptNet === all.filter(([, b]) => b === 'exempt').reduce((s, [a]) => s + a.net, 0));
  check(`${label}: gross = net + tax`, all.every(([a]) => a.gross === a.net + a.tax) && q.totals.gross === q.totals.net + q.totals.tax);
  if (q.status === 'draft') check(`${label}: draft has no number/validity/issuance/document`, q.quoteNumber === null && q.validity === null && q.issuance === null && q.document.available === false);
  if (q.validity && q.validity.source === 'policy') {
    const t = Date.parse(q.issuance.issuedAt); const d1 = civil(t);
    check(`${label}: validity resolution`, q.validity.issueLocalDate === d1 && q.validity.validThroughLocalDate === addDays(d1, 4) && Date.parse(q.validity.validUntilExclusive) === startOf(addDays(d1, 5)), JSON.stringify(q.validity));
  }
  if (q.status === 'issued') check(`${label}: formal-quote evidence complete`, q.quoteNumber && q.totals && q.issuance?.issuedAt && q.validity?.validUntilExclusive && q.document.available === true && /^[0-9a-f]{64}$/.test(q.document.pdfSha256) && q.document.artifactRef === `sha256:${q.document.pdfSha256}`);
  if (q.status === 'issuing') check(`${label}: issuing has number+validity but no document`, q.quoteNumber && q.validity && q.document.available === false);
}
checkQuote(read('examples/quote-issued.json'), 'quote-issued');
checkQuote(read('examples/draft-create.response-201.json'), 'draft-201');
const r201 = read('examples/create-and-issue.response-201.json'), r202 = read('examples/create-and-issue.response-202.json'), i200 = read('examples/issue.response-200.json');
checkQuote(r201.quote, 'create-201'); checkQuote(r202.quote, 'create-202'); checkQuote(i200.quote, 'issue-200');
check('201 example is not issuing', r201.quote.status !== 'issuing' && r201.operation.status === 'succeeded');
check('202 example is issuing', r202.quote.status === 'issuing' && ['pending', 'running'].includes(r202.operation.status));
check('expectedTotals equal owner totals (create)', ['net', 'tax', 'gross'].every((k) => createReq.expectedTotals[k] === r201.quote.totals[k]));
const issueReq = read('examples/issue.request.json');
check('expectedTotals equal owner totals (issue)', ['net', 'tax', 'gross'].every((k) => issueReq.expectedTotals[k] === i200.quote.totals[k]));
check('issue expectedVersion follows draft update', read('examples/draft-update.request.json').expectedVersion === 1 && issueReq.expectedVersion === 2 && i200.quote.version === 4);
const jcs = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(jcs).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(',')}}`;
const body = clone(createReq); delete body.externalCorrelation.correlationId;
const fp = createHash('sha256').update(jcs({ operation: 'quote.create_and_issue', pathParameters: {}, body })).digest('hex');
check('idempotency lookup fingerprint = fingerprint(create request without correlationId)', read('examples/idempotency-lookup.bound.json').binding.requestFingerprint === fp);
check('lookup binding refers to the issued quote', read('examples/idempotency-lookup.bound.json').binding.quoteId === r201.quote.quoteId);

// 6. operation-level contract checks
const scopeDoc = text('QUOTE_V2_SECURITY_SCOPES.md');
const docScopes = new Set([...scopeDoc.matchAll(/^\| `([a-z:]+)` \|/gm)].map((m) => m[1]));
const opNames = new Set(doc.components.schemas.IdempotentOperationName.enum);
const usedOpNames = [];
for (const { path, method, op } of ops) {
  const id = `${method.toUpperCase()} ${path}`;
  const isHealthPublic = path === '/health/live' || path === '/health/ready';
  if (!isHealthPublic) check(`scopes declared: ${id}`, Array.isArray(op['x-required-scopes']) && op['x-required-scopes'].every((s) => docScopes.has(s)), JSON.stringify(op['x-required-scopes']));
  if (method === 'post' || method === 'patch') {
    const hasKey = (op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IdempotencyKey');
    check(`mutation requires Idempotency-Key: ${id}`, hasKey && opNames.has(op['x-idempotency-operation']));
    usedOpNames.push(op['x-idempotency-operation']);
    check(`mutation 401/403 documented: ${id}`, op.responses['401'] && op.responses['403']);
  }
  if (method === 'get' && !path.startsWith('/health')) check(`read has no Idempotency-Key requirement except lookup: ${id}`, path === '/v2/idempotency/current' || !(op.parameters ?? []).some((p) => p.$ref === '#/components/parameters/IdempotencyKey'));
}
check('each idempotent operation name used exactly once', [...opNames].every((n) => usedOpNames.filter((u) => u === n).length === 1) && usedOpNames.length === opNames.size);
check('doc scope matrix == scopes used in OpenAPI (+ read:any modifier)', [...docScopes].every((s) => s === 'quotes:read:any' || JSON.stringify(doc).includes(`"${s}"`)));
const P = doc.paths;
check('201/202 on POST /v2/quotes', P['/v2/quotes'].post.responses['201'] && P['/v2/quotes'].post.responses['202'] && !P['/v2/quotes'].post.responses['200']);
check('200/202 on POST issue', P['/v2/quotes/{quoteId}/issue'].post.responses['200'] && P['/v2/quotes/{quoteId}/issue'].post.responses['202']);
const required = ['post /v2/quotes', 'post /v2/quotes/drafts', 'patch /v2/quotes/{quoteId}/draft', 'post /v2/quotes/{quoteId}/issue', 'get /v2/quotes/{quoteId}', 'get /v2/quotes', 'get /v2/operations/{operationId}', 'get /v2/idempotency/current', 'post /v2/quotes/{quoteId}/cancel', 'get /v2/quotes/{quoteId}/document', 'get /v2/quotes/{quoteId}/audit', 'post /v2/quotes/{quoteId}/deliveries/email', 'get /v2/quotes/{quoteId}/deliveries/{deliveryId}', 'get /health/live', 'get /health/ready', 'get /health/dependencies'];
const have = new Set(ops.map((o) => `${o.method} ${o.path}`));
check('required endpoint inventory present', required.every((r) => have.has(r)), required.filter((r) => !have.has(r)).join(','));
check('no extra endpoints beyond inventory', [...have].every((h) => required.includes(h)), [...have].filter((h) => !required.includes(h)).join(','));
check('no public expire mutation', !Object.keys(P).some((p) => /expire/i.test(p)));
check('no accept / mark-paid / revisions routes', !Object.keys(P).some((p) => /accept|paid|revision/i.test(p)));
check('only one operation can cause email', ops.filter((o) => /deliver/.test(o.path) && o.method === 'post').length === 1 && ops.every((o) => !(o.op['x-required-scopes'] ?? []).includes('quotes:delivery:email') || o.path.endsWith('/deliveries/email')));
check('create/issue descriptions state no email', /No email is sent/.test(P['/v2/quotes'].post.description) && /No email is sent/.test(P['/v2/quotes/{quoteId}/issue'].post.description));
check('QuoteStatus is exactly draft/issuing/issued/expired/cancelled', JSON.stringify(doc.components.schemas.QuoteStatus.enum) === JSON.stringify(['draft', 'issuing', 'issued', 'expired', 'cancelled']));

// 7. doc ↔ OpenAPI consistency
const domain = text('QUOTE_V2_DOMAIN_CONTRACT.md');
const errSection = domain.slice(domain.indexOf('## 12. Errors'), domain.indexOf('## 13. Health'));
const docCodes = new Set([...errSection.matchAll(/^\| `([a-z_]+)` \| (?:\d{3}|—) \|/gm)].map((m) => m[1]));
const enumCodes = new Set(doc.components.schemas.ErrorCode.enum);
check('error catalog doc == ErrorCode enum', docCodes.size === enumCodes.size && [...enumCodes].every((c) => docCodes.has(c)), JSON.stringify({ onlyDoc: [...docCodes].filter((c) => !enumCodes.has(c)), onlyEnum: [...enumCodes].filter((c) => !docCodes.has(c)) }));
const requiredCodes = ['invalid_request', 'validation_error', 'arithmetic_mismatch', 'unauthenticated', 'forbidden', 'quote_not_found', 'document_not_available', 'invalid_state_transition', 'version_conflict', 'idempotency_key_conflict', 'operation_in_progress', 'dependency_unavailable', 'schema_not_ready', 'document_generation_failed', 'document_storage_failed', 'delivery_recipient_missing'];
check('all required error codes present', requiredCodes.every((c) => enumCodes.has(c)));
const sm = text('QUOTE_V2_STATE_MACHINE.md');
const smStates = new Set([...sm.matchAll(/^\| T\d \| (?:`(\w+)`|—) \| `(\w+)` \|/gm)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
check('state machine table states == QuoteStatus enum', [...smStates].sort().join() === [...doc.components.schemas.QuoteStatus.enum].sort().join(), [...smStates].join());
const smEndpoints = [...sm.matchAll(/`(POST|PATCH) (\/v2\/[^`]+)`/g)].map((m) => `${m[1].toLowerCase()} ${m[2].replace('{id}', '{quoteId}')}`);
check('every state-machine endpoint exists in OpenAPI', smEndpoints.every((e) => have.has(e)), smEndpoints.filter((e) => !have.has(e)).join(','));
check('validity examples table matches reference algorithm', (() => { const v = text('QUOTE_V2_VALIDITY_POLICY.md'); const rows = [...v.matchAll(/^\| E\d \| ([0-9TZ:-]+) \| [^|]+\| ([0-9-]+) \| ([0-9-]+) \| ([0-9TZ:-]+) \|/gm)]; return rows.length === 7 && rows.every(([, iso, d1, thr, ex]) => { const t = Date.parse(iso); const dd = civil(t); return dd === d1 && addDays(dd, 4) === thr && startOf(addDays(dd, 5)) === Date.parse(ex); }); })());

// 8. boundary checks (no R4 / Opportunity leakage in the owner contract)
const ownerFiles = ['README.md', 'QUOTE_V2_CONTRACT_FREEZE.md', 'QUOTE_V2_V1_MIGRATION.md', 'openapi.yaml', 'QUOTE_V2_DOMAIN_CONTRACT.md', 'QUOTE_V2_STATE_MACHINE.md', 'QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md', 'QUOTE_V2_VALIDITY_POLICY.md', 'QUOTE_V2_SECURITY_SCOPES.md', 'QUOTE_V2_ROADMAP.md', ...readdirSync(`${DIR}/examples`).map((f) => `examples/${f}`)];
const r4Terms = /\bR4\b|ActionProposal|ActionExecution|executionKey|workspace|\bTask\b|\btask\b|sales[ -]agent|Opportunit/;
const scrub = (f, s) => f === 'QUOTE_V2_CONTRACT_FREEZE.md' ? s.replace(/`R4-J3A_[A-Z0-9_.]+\.md`/g, '`<input>`').replace(/no Opportunity|No endpoint requires Opportunity/g, '') : f === 'QUOTE_V2_V1_MIGRATION.md' ? s.replace(/opportunity_id|"opportunity"|`opportunityId`|Opportunity coupling/g, '') : s;
for (const f of ownerFiles) { const m = scrub(f, text(f)).match(r4Terms); check(`no R4/Opportunity primitive in ${f}`, !m, m ? m[0] : ''); }
check('openapi never mentions opportunity', !/opportunit/i.test(text('openapi.yaml')));
check('no Catalog/Shipping call surface in OpenAPI (no outbound URLs, no lookup params)', !/catalog\.|carrier\/v1|productLookup|priceLookup|currentPrice/i.test(text('openapi.yaml')));

const failed = results.filter((r) => !r.ok);
console.log(`checks: ${results.length}, passed: ${results.length - failed.length}, failed: ${failed.length}`);
for (const f of failed) console.log('FAIL', f.name, f.detail);
process.exitCode = failed.length ? 1 : 0;
