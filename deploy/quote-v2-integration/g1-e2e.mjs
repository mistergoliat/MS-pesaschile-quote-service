// R1.7B-G1 synthetic E2E driver. Usage: node e2e.mjs run|verify <secretsDir> <stateFile>
/* global process, fetch, Buffer, setTimeout, console */
// Prints sanitized evidence only: never tokens, never raw idempotency keys.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

const [mode, secretsDir, stateFile] = process.argv.slice(2);
const BASE = "http://127.0.0.1:4020";
const tok = (n) => readFileSync(`${secretsDir}/token-${n}`, "utf8").trim();
const SYN = tok("synthetic"), MON = tok("monitor");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok: !!ok, ...detail }); };

async function call(method, path, { token, key, body, raw } = {}) {
  const headers = { "X-Correlation-Id": "g1-synthetic-e2e" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers["Idempotency-Key"] = key;
  if (body) headers["Content-Type"] = "application/json";
  const t0 = Date.now();
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ms = Date.now() - t0;
  if (raw) return { status: res.status, ms, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, ms, json, headers: res.headers };
}

async function waitIssued(quoteId, first) {
  if (first.status === 200 || first.status === 201) return first.json.quote;
  const opId = first.json?.operation?.operationId;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const op = await call("GET", `/v2/operations/${opId}`, { token: SYN });
    if (op.json?.status === "succeeded" || op.json?.operation?.status === "succeeded") break;
  }
  return (await call("GET", `/v2/quotes/${quoteId}`, { token: SYN })).json.quote ?? (await call("GET", `/v2/quotes/${quoteId}`, { token: SYN })).json;
}

const customer = { kind: "person", displayName: "Cliente Sintetico G1", email: "g1-synthetic@example.com" };
const corr = (ref) => ({ sourceSystem: "g1-synthetic", externalReferenceType: "test-run", externalReference: ref });
const product = (ref, sku, desc, qty, amount) => ({
  kind: "product",
  item: { sourceSystem: "g1-synthetic", productRef: ref, sku, description: desc },
  quantity: { value: qty, unit: "unit" },
  unitPrice: { amount, taxBasis: "included", taxRate: "0.19" }
});

// Independent arithmetic (CLP, per-line, tax-included → net = round(gross / 1.19)).
const inclLine = (qty, unit) => { const gross = qty * unit; const net = Math.round(gross / 1.19); return { net, tax: gross - net, gross }; };
const exclLine = (amount) => { const tax = Math.round(amount * 0.19); return { net: amount, tax, gross: amount + tax }; };
const sum = (ls) => ls.reduce((a, l) => ({ net: a.net + l.net, tax: a.tax + l.tax, gross: a.gross + l.gross }), { net: 0, tax: 0, gross: 0 });

function verifyIssued(label, q, expected) {
  check(`${label}: status issued`, q.status === "issued", { status: q.status });
  check(`${label}: quote number`, /^[A-Z]+-\d+$/.test(q.quoteNumber ?? ""), { quoteNumber: q.quoteNumber });
  check(`${label}: totals = independent arithmetic`, q.totals.net === expected.net && q.totals.tax === expected.tax && q.totals.gross === expected.gross, { totals: q.totals, expected });
  check(`${label}: issuer pesaschile-cl-v2`, q.issuance?.issuerProfileId === "pesaschile-cl-v2", { issuer: q.issuance?.issuerProfileId });
  check(`${label}: template v5`, q.document?.templateVersion === "quote-pdf-template-v5", { template: q.document?.templateVersion });
  check(`${label}: renderer node24/zlib pinned`, (q.document?.rendererVersion ?? "").includes("node24+zlib-1.3.1-e00f703"), { renderer: q.document?.rendererVersion });
  const v = q.validity, d = (s) => new Date(s + "T00:00:00Z").getTime();
  check(`${label}: validity 5 calendar days`, v?.policyId === "cl-retail-5-calendar-days-v1" && (d(v.validThroughLocalDate) - d(v.issueLocalDate)) / 86400000 === 4, { validity: { policyId: v?.policyId, issueLocalDate: v?.issueLocalDate, validThroughLocalDate: v?.validThroughLocalDate, validUntilExclusive: v?.validUntilExclusive } });
  check(`${label}: document available`, q.document?.available === true && /^[0-9a-f]{64}$/.test(q.document?.pdfSha256 ?? ""), { pdfSha256: q.document?.pdfSha256, byteLength: q.document?.byteLength });
}

async function verifyDocument(label, q) {
  const doc = await call("GET", `/v2/quotes/${q.quoteId}/document`, { token: SYN, raw: true });
  const b = doc.bytes;
  check(`${label}: document HTTP 200 application/pdf`, doc.status === 200 && (doc.headers.get("content-type") ?? "").startsWith("application/pdf"), { status: doc.status, ms: doc.ms });
  check(`${label}: PDF sha256 = manifest`, sha(b) === q.document.pdfSha256, { sha256: sha(b) });
  check(`${label}: PDF byteLength = manifest`, b.length === q.document.byteLength, { bytes: b.length });
  check(`${label}: PDF structure`, b.subarray(0, 5).toString() === "%PDF-" && b.subarray(-8).toString().includes("%%EOF"), {});
  return sha(b);
}

if (mode === "run") {
  const st = { keys: {}, quotes: {} };
  // F. Authentication (before any business data)
  const fakeToken = "g1" + "x".repeat(50);
  check("auth: no token → 401", (await call("POST", "/v2/quotes/drafts", { key: "g1-noauth", body: {} })).status === 401);
  check("auth: unknown token → 401", (await call("GET", "/v2/quotes?sourceSystem=g1-synthetic", { token: fakeToken })).status === 401);
  const forb = await call("POST", "/v2/quotes/drafts", { token: MON, key: "g1-forbidden", body: {} });
  check("auth: monitor token on business route → 403", forb.status === 403, { code: forb.json?.code, requiredScope: forb.json?.details?.requiredScope ?? forb.json?.requiredScope });
  check("auth: synthetic token on /health/dependencies → 403", (await call("GET", "/health/dependencies", { token: SYN })).status === 403);
  const em = await call("POST", `/v2/quotes/${randomUUID()}/deliveries/email`, { token: SYN, key: "g1-email", body: {} });
  check("auth: synthetic principal lacks quotes:delivery:email → 403", em.status === 403, { status: em.status });

  // A. Draft
  st.keys.draft = `g1-draft-${randomUUID()}`;
  const draftBody = {
    externalCorrelation: corr("G1-SYNTHETIC-DRAFT-001"),
    customer,
    lines: [
      product("g1-p-001", "G1-SYN-001", "Producto sintetico G1 A", "2", 11900),
      { kind: "service", item: { sourceSystem: "g1-synthetic", description: "Servicio sintetico exento G1" }, quantity: { value: "1", unit: "unit" }, unitPrice: { amount: 15000, taxBasis: "exempt" } }
    ]
  };
  const dr = await call("POST", "/v2/quotes/drafts", { token: SYN, key: st.keys.draft, body: draftBody });
  const draft = dr.json?.quote ?? dr.json;
  check("A: draft created 201", dr.status === 201 && draft?.status === "draft", { status: dr.status, quoteStatus: draft?.status, version: draft?.version, ms: dr.ms, err: dr.status >= 400 ? dr.json : undefined });
  if (dr.status !== 201) { console.log(JSON.stringify(results, null, 1)); process.exit(1); }
  const rd = await call("GET", `/v2/quotes/${draft.quoteId}`, { token: SYN });
  const rdq = rd.json?.quote ?? rd.json;
  check("A: draft readback", rd.status === 200 && rdq.quoteId === draft.quoteId && rdq.lines.length === 2 && rdq.status === "draft", { status: rd.status });
  const drReplay = await call("POST", "/v2/quotes/drafts", { token: SYN, key: st.keys.draft, body: draftBody });
  check("D: draft replay same key → same quote", (drReplay.json?.quote ?? drReplay.json)?.quoteId === draft.quoteId, { status: drReplay.status });

  // B. Issue the draft
  const draftExpected = sum([inclLine(2, 11900), { net: 15000, tax: 0, gross: 15000 }]);
  st.keys.issue = `g1-issue-${randomUUID()}`;
  const issueBody = { expectedVersion: rdq.version, expectedTotals: draftExpected };
  const is = await call("POST", `/v2/quotes/${draft.quoteId}/issue`, { token: SYN, key: st.keys.issue, body: issueBody });
  check("B: issue accepted", [200, 201, 202].includes(is.status), { status: is.status, ms: is.ms, err: is.status >= 400 ? is.json : undefined });
  const issued = await waitIssued(draft.quoteId, is);
  verifyIssued("B", issued, draftExpected);
  st.quotes.draftIssued = { quoteId: issued.quoteId, quoteNumber: issued.quoteNumber, pdfSha256: issued.document.pdfSha256, byteLength: issued.document.byteLength, totals: issued.totals, issueBody, draftBody };
  await verifyDocument("C(B)", issued);
  const isReplay = await call("POST", `/v2/quotes/${draft.quoteId}/issue`, { token: SYN, key: st.keys.issue, body: issueBody });
  const isrq = isReplay.json?.quote;
  check("D: issue replay same key → same number and PDF", isrq?.quoteNumber === issued.quoteNumber && isrq?.document?.pdfSha256 === issued.document.pdfSha256, { status: isReplay.status });
  const arith = await call("POST", "/v2/quotes/drafts", { token: SYN, key: `g1-arith-${randomUUID()}`, body: draftBody });
  const arithQ = arith.json?.quote ?? arith.json;
  const bad = await call("POST", `/v2/quotes/${arithQ.quoteId}/issue`, { token: SYN, key: `g1-arith-issue-${randomUUID()}`, body: { expectedVersion: arithQ.version, expectedTotals: { ...draftExpected, gross: draftExpected.gross + 1 } } });
  check("B: wrong expectedTotals rejected (422, not issued)", bad.status === 422, { status: bad.status, code: bad.json?.code });
  st.quotes.arithmeticRejectedDraft = { quoteId: arithQ.quoteId };

  // B2. Create-and-issue (R4-style), with shipping
  const caiExpected = sum([inclLine(1, 89990), inclLine(3, 24990), exclLine(5990)]);
  st.keys.cai = `g1-cai-${randomUUID()}`;
  const caiBody = {
    externalCorrelation: corr("G1-SYNTHETIC-CAI-001"),
    customer,
    lines: [product("g1-p-002", "G1-SYN-002", "Producto sintetico G1 B", "1", 89990), product("g1-p-003", "G1-SYN-003", "Producto sintetico G1 C", "3", 24990)],
    shipping: {
      carrier: { code: "g1-carrier", name: "Transportista sintetico G1" },
      serviceType: { code: "domicilio", name: "Entrega sintetica" },
      destination: { commune: "Santiago", region: "Región Metropolitana", country: "CL" },
      amount: { amount: 5990, taxBasis: "excluded", taxRate: "0.19" }
    },
    expectedTotals: caiExpected
  };
  const cai = await call("POST", "/v2/quotes", { token: SYN, key: st.keys.cai, body: caiBody });
  check("B2: create-and-issue accepted", [200, 201, 202].includes(cai.status), { status: cai.status, ms: cai.ms, err: cai.status >= 400 ? cai.json : undefined });
  const caiQ = await waitIssued(cai.json?.quote?.quoteId ?? cai.json?.operation?.quoteId, cai);
  verifyIssued("B2", caiQ, caiExpected);
  await verifyDocument("C(B2)", caiQ);
  st.quotes.createAndIssue = { quoteId: caiQ.quoteId, quoteNumber: caiQ.quoteNumber, pdfSha256: caiQ.document.pdfSha256, byteLength: caiQ.document.byteLength, totals: caiQ.totals, caiBody };
  const caiReplay = await call("POST", "/v2/quotes", { token: SYN, key: st.keys.cai, body: caiBody });
  check("D: create-and-issue replay → same quote/number/PDF", caiReplay.json?.quote?.quoteId === caiQ.quoteId && caiReplay.json?.quote?.quoteNumber === caiQ.quoteNumber && caiReplay.json?.quote?.document?.pdfSha256 === caiQ.document.pdfSha256, { status: caiReplay.status });
  const conflict = await call("POST", "/v2/quotes", { token: SYN, key: st.keys.cai, body: { ...caiBody, customer: { ...customer, displayName: "Cliente Sintetico G1 Otro" } } });
  check("D: same key, different body → 409", conflict.status === 409, { status: conflict.status, code: conflict.json?.code });
  const list = await call("GET", "/v2/quotes?sourceSystem=g1-synthetic&externalReferenceType=test-run&externalReference=G1-SYNTHETIC-CAI-001", { token: SYN });
  const items = list.json?.items ?? list.json?.quotes ?? [];
  check("D: exactly one quote for the create-and-issue correlation", list.status === 200 && items.length === 1, { status: list.status, count: items.length });
  writeFileSync(stateFile, JSON.stringify(st), { mode: 0o600 });
} else {
  const st = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const [label, s] of Object.entries({ draftIssued: st.quotes.draftIssued, createAndIssue: st.quotes.createAndIssue })) {
    const g = await call("GET", `/v2/quotes/${s.quoteId}`, { token: SYN });
    const q = g.json?.quote ?? g.json;
    check(`E(${label}): readable after restart, same number`, g.status === 200 && q.status === "issued" && q.quoteNumber === s.quoteNumber, { quoteNumber: q?.quoteNumber });
    check(`E(${label}): same document hash`, q.document?.pdfSha256 === s.pdfSha256 && q.document?.byteLength === s.byteLength);
    const h = await verifyDocument(`E(${label})`, q);
    check(`E(${label}): served bytes identical to pre-restart`, h === s.pdfSha256);
  }
  const r1 = await call("POST", `/v2/quotes/${st.quotes.draftIssued.quoteId}/issue`, { token: SYN, key: st.keys.issue, body: st.quotes.draftIssued.issueBody });
  check("E: issue replay after restart → same number", r1.json?.quote?.quoteNumber === st.quotes.draftIssued.quoteNumber, { status: r1.status });
  const r2 = await call("POST", "/v2/quotes", { token: SYN, key: st.keys.cai, body: st.quotes.createAndIssue.caiBody });
  check("E: create-and-issue replay after restart → same quote", r2.json?.quote?.quoteId === st.quotes.createAndIssue.quoteId && r2.json?.quote?.document?.pdfSha256 === st.quotes.createAndIssue.pdfSha256, { status: r2.status });
}
const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ mode, passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exit(failed.length ? 1 : 0);
