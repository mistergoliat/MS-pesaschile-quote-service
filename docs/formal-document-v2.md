# Quote Service — V2 Formal Document (R1.5B2)

Status: **implemented; drives formal issuance since R1.5B3**
([issuance-execution.md](issuance-execution.md)). B2 is pure rendering. It
publishes nothing, writes no manifest and claims no operation. B3 wires it
into the attempt body. Normative semantics: [Domain §9](v2/QUOTE_V2_DOMAIN_CONTRACT.md#9-document).
Decisions it rests on: [R1.5B0 audit](R1.5B0_ISSUANCE_PRIMITIVE_SALVAGE_AUDIT.md) §E–§G and §S.

```
IssuedSnapshot (B1, frozen DB state)
  → buildIssuedQuoteDocumentModelV2      pure: no DB, clock, env, lookups or arithmetic
  → IssuedQuoteDocumentModelV2           display text only
  → PdfRendererPort.renderPdf            pdfmake, pinned stack, glyph check
  → PDF bytes                            deterministic for (model, templateVersion, rendererVersion)
```

## 1. Document model

`IssuedQuoteDocumentModelV2` (`src/application/quote-v2/document/issued-quote-document-model.ts`)
holds the following:

| Member | Content |
|---|---|
| `quoteNumber` | the only identifier on the document |
| `issuedAt` | frozen instant, used only as the PDF `CreationDate` |
| `issueDate` | "Fecha de emisión: DD/MM/AAAA" from `validity.issueLocalDate` |
| `validityStatement` | "Válida hasta el DD/MM/AAAA inclusive (hora de Chile)" from `validity.validThroughLocalDate` (never derived from `validUntilExclusive`) |
| `issuer` | from the issuer profile (§3) |
| `customer` | rows rendered as given (§4) |
| `lines` | description, SKU, variant attributes, quantity + unit, unit amount, tax-basis label, net/tax/gross |
| `shipping` / `shippingAbsent` | structured block, or "Despacho no incluido" |
| `totals` | net, exempt net (only if > 0), tax, gross |
| `taxStatement` | "Valores con IVA incluido." only when every charge (lines and shipping) is `included` |

It never contains `quoteId`, line ids, `externalCorrelation`, item
references, provenance, idempotency data or worker/lease data (tested).

**No second commercial authority.** Every amount shown is a value frozen at
acceptance. It is only formatted: CLP with dot grouping, quantities with a
decimal comma, rates as percentages by string shifting. Civil dates are
reformatted as strings, never through `Date`. The V1
`formatCommercialUnitPriceDisplay` and `formatUtcDateDisplay` are not
reachable from this path.

## 2. Versions

| Version | Owns | Bump when |
|---|---|---|
| `templateVersion` = `quote-pdf-template-v4` (`template-v4.ts`) | All document wording and layout, plus the issuer profile used | Any visible wording, label, layout or issuer-content change (U2/U3 resolutions included) |
| `rendererVersion` = `quote-pdf-r4+pdfmake-0.2.20+pdfkit-0.15.3+node24+zlib-1.3.1-e00f703+dejavu-sans-2.37` (`renderer-profile.ts`) | The byte-producing stack | Any change to pdfmake/pdfkit/fontkit/linebreak/png-js, the Node major, Node's bundled zlib, or the font files |

`RENDERER_PROFILE` pins the package versions, Node major, zlib build and font
SHA-256 values, and `RENDERER_VERSION` is derived from it. The renderer checks
the running stack at construction and refuses to render on any difference:
readiness reports `renderer_unavailable` and the error is `renderer_unavailable`.
A unit test fails when `package-lock.json`, the installed packages,
`package.json` (`pdfmake` pinned exactly, `engines`) or the Dockerfile image
drift from the profile. Neither label comes from the environment:
`QUOTE_RENDER_VERSION` was removed, and `QUOTE_COMPANY_NAME` now feeds only
the legacy email scripts.

**Why zlib.** pdfkit deflates content streams and re-deflates the RGBA logo
with `node:zlib`, whatever the `compress` flag says. Node 20 ships zlib
`1.3.0.1-motley` and Node 24.14.0 ships `1.3.1-e00f703`, so zlib is part of the
bytes. The runtime image pins `node:24.14.0-bookworm-slim`.

## 3. Issuer profile (U3 open)

`pesaschile-cl-v1` (`issuer-profiles.ts`) is code-owned and selected by the
snapshot's frozen `issuerProfileId`. Its fields are legal name
"Pesas Chile SPA", website and logo asset. RUT and address are `null` until
U3 approves them. The document then prints "Datos tributarios del emisor
pendientes de aprobación" instead of inventing values. `contentStatus` is
`provisional-u3`: **not production-final** (gate R1.7).

**No personal signature (U-B closed).** The V1 named-employee block (name,
role, phone, address) is gone from the formal PDF. The formal document
carries issuer-profile identity only. `createDefaultPesasChileSenderSignatureV1`
remains for the legacy email until R1.6.

## 4. Customer, lines, shipping, tax

- **Customer** (Domain §15): guest → displayName/email/phone/address as given,
  or exactly "Cliente: no informado" when there is no data. Person →
  displayName, RUT, contact. Company → legal name, "Nombre de fantasía",
  RUT, "Contacto", contact. Address is lines, commune, region and country
  (`CL` → "Chile"). `externalCustomerReference` is never shown.
- **Lines**: unit labels `unit → unid.`, `service → servicio`, `hour → h`,
  `m2 → m²`, `m3 → m³`. Any other code is printed as is.
- **Shipping**: carrier, service type (if any), destination commune/region,
  amount with basis, and net/tax/gross in its own block. It is never a line
  (no V1 shipping-line semantics).
- **Tax (U2 open, `provisional-u2`)**: per-charge labels "IVA 19% incluido",
  "Neto + IVA 19%", "Exento de IVA". The global statement appears only when
  every charge is `included`. The wording lives only in `template-v4.ts`.

## 5. Unicode and font policy (U-A closed)

Fonts: **DejaVu Sans 2.37** Regular and Bold, version-controlled at
`src/infrastructure/documents/assets/fonts/` with `LICENSE-DejaVu.txt`
(Bitstream Vera licence plus public-domain DejaVu changes; free to
redistribute and embed). Source: npm `dejavu-fonts-ttf@2.37.3`. Pinned by
SHA-256. Embedded as subsets, so no host font is ever used.

**Supported glyphs** are the code points present in *both* faces. That covers
Latin-1, Latin Extended-A/B (Ł, Ő, ź, ñ…), Greek, Cyrillic, general
punctuation, currency (€), arrows (→), mathematical operators (≤ ≥ ≈ ≠ ∞),
dingbat checkmarks (✓ ✔) and a few monochrome emoji present in DejaVu
(😀 ❤).

**Unsupported** are CJK, Hangul, and most emoji (👍 🔥 🚀 ✅). No fallback font
is embedded: a CJK face is far larger than the document, and pdfmake has no
per-glyph fallback. Before layout the renderer checks every character of the
model and fails with `DocumentRenderError("unsupported_glyph", codePoints)`,
which maps to `document_generation_failed`. Text is never stripped, replaced
or drawn as `.notdef`. Supporting a new script means adding a font, which is
a new `rendererVersion`.

Tests extract the rendered text with pdfjs-dist (test-only) and compare it to
the input. They do not stop at "render() did not throw".

## 6. Determinism and repair

PDF `CreationDate` is the frozen `issuedAt`. There is no `ModDate` and no
random identifier: the trailer `/ID` is derived from the info dictionary.
`Producer` is the renderer version. Assets are loaded once, from
module-relative paths, with no `cwd` fallback.

Seven golden fixtures are pinned in `native-pdf-renderer.test.ts`: person with
shipping, company with mixed tax, guest without data, guest with contact,
long descriptions, 100 lines, and Latin Extended + symbols. They are identical:

- on Windows (Node 24.14.0), repeated, fresh vs reused renderer, concurrent;
- in separate processes under TZ/LANG `UTC/C`, `Asia/Tokyo/ja_JP`,
  `America/Santiago/es_CL` and `Pacific/Kiritimati/tr_TR`;
- in the Linux runtime image (`node:24.14.0-bookworm-slim`, same zlib) under
  `UTC/C`, `Asia/Tokyo/ja_JP` and `America/Santiago/es_CL`
  (`npm run pdf:determinism:runtime`).

**Repair (Domain §9.3)** must run a build whose `RENDERER_VERSION` equals the
manifest's `rendererVersion`, from the same template version, with the same
pinned assets. The renderer refuses any other stack, so a repair either
reproduces the recorded `pdfSha256` or fails.

## 7. Security of the pdfmake input

Model values only ever become `text` values. `image`, `images`, `font`,
`svg`, `link`, attachments and all other resource-bearing properties are
template constants (`issuerLogo`, `QuoteSans`). A structural test walks the
real definition with hostile values, such as an image key name, a data URI, a
URL, a Windows path and HTML. A rendered-PDF test proves there is no `/URI`,
no `/Annots`, no JavaScript, no embedded file and no extra image. The document
modules import no network client.

`DocumentRenderError` messages are fixed text: no snapshot text, font path or
stack detail. `codePoints` is internal diagnostic data.

## 8. Cost (Windows, Node 24.14.0, warm, sequential)

| Lines | Median | Max | PDF bytes | V1 (Helvetica) bytes / median |
|---|---|---|---|---|
| 1 | 59 ms | 85 ms | 31 547 | 6 933 / 19 ms |
| 10 | 93 ms | 117 ms | 33 877 | 9 169 / 25 ms |
| 100 | 116 ms | 164 ms | 63 400 | 28 868 / 74 ms |

The increase comes from the embedded font subsets (about +25 KB) and pdfkit
re-parsing the two TTFs for every document. Ten concurrent 30-line renders
take about +86 MiB RSS. The intended B3 model is one render at a time per
process. No optimization was done.

## 9. Removed from the V2 path

- `renderQuotePrintableHtml`: no HTML artifact in V2 (C17).
- The V1 PDF view model and `createIssuedQuoteContentHash`.
- `formatUtcDateDisplay`.
- The env-owned render version and the named-employee signature.

`CanonicalIssuedQuoteSnapshot`, `buildCanonicalIssuedQuoteSnapshot`, the
email view model and `formatCommercialUnitPriceDisplay` remain only for the
legacy email (R1.6). They are marked LEGACY, and an import-closure test proves
the V2 document path cannot reach them. `IssuedDocumentSet` (V1 domain) is
untouched and unused by V2.

## 10. Deferred

| Item | Slice |
|---|---|
| ~~Real attempt body, `DocumentRenderError` mapping (A5: `unsupported_glyph` non-retryable), inline budget, job composition~~ | B3: done |
| `GET …/document`, integrity job, crash-window tests | B4 |
| U2 tax wording, U3 issuer RUT/address/contact (template/profile bump) | before production (R1.7) |
| V2 email (drops the legacy V1 snapshot surface) | R1.6 |
