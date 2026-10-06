/*
 * Formal quote template v4: every customer-visible word of the V2 PDF lives
 * here (or in the issuer profile), never in the renderer. Changing any of it
 * changes the document and requires a new TEMPLATE_VERSION.
 *
 * Contract wording (Domain §9.1) is used verbatim where the contract fixes it:
 * the validity statement, "Cliente: no informado", "Despacho no incluido" and
 * the global "valores con IVA incluido" statement. The per-charge tax basis
 * labels are U2 (finance review, freeze record): provisional until approved.
 */

export const TEMPLATE_VERSION = "quote-pdf-template-v4";

export const TEMPLATE_V4_CONTENT_STATUS = {
  /** U2: tax labels and the global VAT statement wording await finance review. */
  taxWording: "provisional-u2"
} as const;

export const TEMPLATE_V4 = {
  documentTitle: "COTIZACIÓN",
  issueDateLabel: "Fecha de emisión",
  validityStatement: (throughDate: string) => `Válida hasta el ${throughDate} inclusive (hora de Chile)`,
  currencyLabel: "Moneda: CLP (pesos chilenos)",

  issuerHeading: "EMISOR",
  issuerRutLabel: "RUT",
  issuerPendingNotice: "Datos tributarios del emisor pendientes de aprobación",

  customerHeading: "CLIENTE",
  customerNotInformed: "Cliente: no informado",
  customerRutLabel: "RUT",
  customerTradeNameLabel: "Nombre de fantasía",
  customerContactLabel: "Contacto",
  customerEmailLabel: "Correo",
  customerPhoneLabel: "Teléfono",
  countryNames: { CL: "Chile" } as Readonly<Record<string, string>>,

  linesHeading: "DETALLE",
  columns: {
    description: "DESCRIPCIÓN",
    quantity: "CANTIDAD",
    unitAmount: "PRECIO UNITARIO",
    net: "NETO",
    tax: "IVA",
    gross: "TOTAL"
  },
  skuLabel: "SKU",
  unitLabels: { unit: "unid.", service: "servicio", hour: "h", m2: "m²", m3: "m³" } as Readonly<Record<string, string>>,

  shippingHeading: "DESPACHO",
  shippingAbsent: "Despacho no incluido",
  shippingCarrierLabel: "Transportista",
  shippingServiceLabel: "Servicio",
  shippingDestinationLabel: "Destino",

  totals: { net: "Neto", exemptNet: "Neto exento", tax: "IVA", gross: "Total" },

  /** U2 provisional: per-charge basis labels; `rate` is a display percentage such as "19". */
  taxBasis: {
    included: (rate: string) => `IVA ${rate}% incluido`,
    excluded: (rate: string) => `Neto + IVA ${rate}%`,
    exempt: () => "Exento de IVA"
  },
  /** Contract: allowed only when every charge has taxBasis = included. */
  allIncludedStatement: "Valores con IVA incluido.",

  pageLabel: (page: number, count: number) => `Página ${page} de ${count}`,
  pdfTitle: (quoteNumber: string) => `Cotización ${quoteNumber}`,
  pdfSubject: "Cotización comercial",
  pdfCreator: "PesasChile Quote Service"
} as const;
