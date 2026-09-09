# QUOTE-R1-T07D — Lightweight Native PDF Renderer

## Estado

- Branch: `feat/quote-r1-t07d-lightweight-pdf-renderer`
- Baseline: `80aba117f4bc6b150e9fcebbbef82e7d5a29b7af`
- Precondición T1.1: cumplida; `eec6dfb` está mergeado en `main`.
- Commit creado: no.
- Render version: `quote-pdf-v2-pdfmake`

## Objetivo y alcance

Se reemplazó el renderer PDF basado en navegador por un renderer nativo basado en
`pdfmake`, manteniendo intactos el dominio de cotizaciones, lifecycle, persistencia,
storage, document refs, Gmail delivery, email HTML, idempotencia, identidad externa,
eventos de auditoría y expiración.

El pipeline actual es:

```text
CanonicalIssuedQuoteSnapshot → pdfmake → PDF Buffer → storage → document ref → Gmail attachment
```

El printable HTML existente se conserva como artefacto/API compatible. No es usado
para generar el PDF nativo. El email HTML tampoco fue eliminado ni rediseñado.

## Auditoría del footprint anterior

Antes del cambio se encontraron referencias a Puppeteer/Chromium en:

- Runtime: `src/infrastructure/documents/puppeteer-pdf-renderer.ts`, `src/app.ts` y wiring HTTP/readiness.
- Configuración: `QUOTE_PDF_EXECUTABLE_PATH` y timeout específico del browser.
- Dependencias: `puppeteer`, `puppeteer-core` transitivo y `chromium-bidi` transitivo.
- Docker: cache de Puppeteer, instalación de `chrome-headless-shell` y librerías gráficas.
- Tests: renderer unitario, helper de executable path y variables de integración.
- Scripts: instalación del browser y Docker smoke.
- Documentación: setup local y runbook de producción.

Se eliminaron todas las piezas runtime específicas del navegador.

## Boundary del renderer

El port se movió a:

```ts
interface PdfRendererPort {
  renderPdf(snapshot: CanonicalIssuedQuoteSnapshot): Promise<Buffer>;
  checkReadiness(): Promise<DependencyReadinessStatus>;
}
```

Implementación: `src/infrastructure/documents/native-pdf-renderer.ts`.

`RealDocumentIssuanceAdapter` continúa siendo responsable de construir el snapshot,
calcular `contentHash`, generar los artefactos y persistirlos. El renderer solamente
proyecta el snapshot a PDF.

## Compatibilidad del snapshot

El renderer recibe exactamente el mismo `CanonicalIssuedQuoteSnapshot` de la emisión.
No consulta PostgreSQL, no rehidrata Catalog, no lee la cotización mutable y no
recalcula pricing.

Los campos T1.1 siguientes permanecen en snapshot, hash y persistence, pero no se
renderizan en el PDF:

- `externalSource`
- `externalItemId`
- `externalVariantId`

El PDF muestra solamente información customer-facing: cliente, descripción, SKU,
cantidad, precios, subtotales, IVA y total.

## Capacidades del renderer nativo

- Tablas pdfmake con encabezado repetido.
- `dontBreakRows` para evitar filas partidas ilegiblemente.
- Wrapping y paginación automática.
- Footer con número de página.
- Logo SVG versionado dentro del repositorio.
- Colores PesasChile:
  - Raspberry `#E62158`
  - Gunmetal `#1D2B35`
  - Anti-Flash White `#ECF0F1`
- Fuente PDF estándar Helvetica y variantes estándar.
- Sin dependencia de fonts instaladas en el sistema operativo.
- Sin lógica comercial ni operaciones floating point para totals.

Poppins no se embebe porque no existe una fuente Poppins local redistribuible y
legítimamente disponible en el repositorio. La diferencia está documentada y el PDF
usa una fuente estándar permitida.

## Contenido del PDF

Se preservan funcionalmente:

- branding PesasChile y logo;
- quote number;
- fecha de emisión y vigencia;
- customer snapshot;
- líneas de producto/servicio;
- descripción y SKU cuando existe;
- cantidad, precio unitario, subtotal, IVA y total por línea;
- subtotal, impuesto y total general;
- condiciones comerciales;
- firma configurada e información corporativa.

No se agregó shipping ni funcionalidad de negocio nueva.

## Versionado y hashes

La versión cambió explícitamente de `quote-v1` a `quote-pdf-v2-pdfmake`.

- `contentHash`: hash del snapshot canónico; no depende de los bytes del PDF.
- `pdfSha256`: hash del Buffer PDF realmente generado y persistido.
- PDFs históricos no se regeneran.
- Los PDFs nuevos son binariamente distintos de los PDFs históricos.
- Se fija `creationDate` a `issuedAt` para evitar timestamps de generación variables.
- El test unitario confirma hash estable para el mismo snapshot.

## Storage y Gmail

No se modificó la abstracción de storage ni los document refs.

El flujo continúa siendo:

```text
issue → generar PDF → persistir Buffer → guardar pdfSha256 → enviar email leyendo PDF durable
```

El worker de email no regenera el PDF. Se agregó una aserción de integración para
comparar el attachment enviado contra el PDF recuperado desde el document ref durable.

## Configuración y Docker

Eliminado:

- `QUOTE_PDF_EXECUTABLE_PATH`
- `QUOTE_PDF_RENDER_TIMEOUT_MS`
- `PUPPETEER_CACHE_DIR`
- instalación de `chrome-headless-shell`;
- librerías gráficas agregadas exclusivamente para Chromium;
- script `pdf:install-browser`.

Agregado:

- dependencia `pdfmake@0.2.20`;
- `pdf:preview`;
- `pdf:benchmark`;
- `pdf:concurrency-smoke`.

La imagen Docker runtime ya no descarga ni contiene Chromium/headless-shell.
PostgreSQL no fue modificado.

## Previews

Comando:

```bash
npm run pdf:preview
```

Genera:

- `.tmp-pdf-previews/quote-short.pdf` — 1 línea, 4,963 bytes.
- `.tmp-pdf-previews/quote-long.pdf` — 30 líneas, 12,890 bytes.
- `.tmp-pdf-previews/quote-multipage.pdf` — 100 líneas, 32,018 bytes.

Las previews validan visualmente la estructura corporativa, wrapping, paginación,
totales y footer. No se exige igualdad pixel a pixel con el HTML anterior.

## Benchmark de memoria

Comando:

```bash
npm run pdf:benchmark
```

Medición real del build runtime local:

| Renderer | Líneas | RSS antes | RSS peak/después | Duración | PDF |
|---|---:|---:|---:|---:|---:|
| pdfmake | 10 | 64.4 MB | 76.5 MB | 82.71 ms | 7,988 bytes |
| pdfmake | 30 | 76.5 MB | 83.1 MB | 53.70 ms | 12,890 bytes |

No existe baseline Puppeteer comparable después de eliminarlo del proyecto y del
runtime. No se reportan números teóricos.

## Concurrency smoke

Comando:

```bash
npm run pdf:concurrency-smoke
```

Resultados del build runtime local:

| Concurrencia | RSS antes | RSS después | Duración | Resultado |
|---:|---:|---:|---:|---|
| 1 | 64.6 MB | 82.3 MB | 114.04 ms | PDF válido |
| 5 | 82.3 MB | 107.3 MB | 239.70 ms | Todos válidos |
| 10 | 107.4 MB | 156.1 MB | 379.48 ms | Todos válidos |

No se crean procesos externos ni procesos de browser.

## Tests y validación

Pasaron:

```text
npm run lint
npm run typecheck
npm run build
npx vitest run --config vitest.unit.config.mts
```

Resultado unitario: 15 archivos, 77 tests aprobados.

Los tests cubren:

- firma `%PDF-` y tamaño mínimo;
- 1, 10, 30 y 100 líneas;
- paginación y descripciones largas;
- readiness sin executable path;
- hash estable;
- ocultamiento de identidad externa;
- compatibilidad del render version;
- persistencia y relectura de documentos existente;
- attachment Gmail desde el PDF durable.

La suite completa `npm test` y Docker smoke no pudieron ejecutarse porque Docker
Desktop no estaba disponible en el entorno:

```text
failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine
```

Esto bloqueó únicamente la validación de integración con PostgreSQL/Docker; no
produjo un fallo del renderer unitario, typecheck, lint o build.

## Referencias restantes

No quedan referencias runtime a:

- Puppeteer;
- Chromium/Chrome/headless-shell;
- `QUOTE_PDF_EXECUTABLE_PATH`;
- `browser.launch`;
- `page.setContent`;
- `page.pdf`.

## Archivos principales modificados

- `src/infrastructure/documents/native-pdf-renderer.ts`
- `src/infrastructure/documents/real-document-issuance.ts`
- `src/app.ts`
- `src/infrastructure/config/env.ts`
- `Dockerfile`
- `package.json`
- `package-lock.json`
- `README.md`
- `test/unit/native-pdf-renderer.test.ts`
- `test/integration/quote-email-runtime.integration.test.ts`

## Veredicto

`LIGHTWEIGHT_PDF_RENDERER_READY`

La implementación nativa está lista a nivel de código, renderer, unit tests,
build, benchmarks y smoke de concurrencia. La validación de integración Docker queda
pendiente hasta disponer de Docker Desktop/PostgreSQL operativo.
