import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { compact, extractPdfText } from "../helpers/pdf-text";

describe("R1.7A offline MIME/email preview", () => {
  it.each(["Camila Rojas", ""])("writes exact approved copy and an unchanged PDF attachment for greeting %j", async (name) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quote-r17a-email-preview-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", "src/scripts/preview-quote-email.ts", "PC-000123", "2026-10-06", name, directory], {
        encoding: "utf8", timeout: 30_000
      });
      expect(result.status, result.stderr).toBe(0);
      const greeting = name ? `Hola ${name},` : "Hola,";
      const copy = fs.readFileSync(path.join(directory, "quote-email-envelope.txt"), "utf8");
      expect(copy).toBe([
        "Cotización Pesas Chile PC-000123", "", greeting, "",
        "Adjuntamos la cotización PC-000123 emitida el 06/10/2026.",
        "La cotización formal se encuentra en el archivo PDF adjunto.",
        "Para consultas, responde a este correo.", "", "Pesas Chile", ""
      ].join("\n"));
      expect(copy).not.toMatch(/76\.921|Valech|S\.p\.A|IVA|Neto|Total|precio|despacho|v[aá]lida|\$/i);
      const mime = fs.readFileSync(path.join(directory, "quote-email-envelope.eml"), "utf8");
      const subject = mime.match(/Subject: ([\s\S]*?)\r\nMessage-ID:/)![1]!.replace(/\r\n /g, "");
      expect(subject.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/g, (_match, base64: string) => Buffer.from(base64, "base64").toString("utf8"))).toBe("Cotización Pesas Chile PC-000123");
      expect(mime).toContain("To: recipient@example.com\r\n");
      expect(mime).toContain("Reply-To: reply@example.com\r\n");
      const attached = mime.match(/Content-Disposition: attachment; filename="PC-000123.pdf"\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/)![1]!;
      const pdf = fs.readFileSync(path.join(directory, "PC-000123.pdf"));
      expect(Buffer.from(attached.replace(/\r\n/g, ""), "base64").equals(pdf)).toBe(true);
      const text = compact(await extractPdfText(pdf));
      expect(text).toContain("PesasChileS.p.A");
      expect(text).toContain("RUT:76.921.044-K");
      expect(text).not.toContain("pendientesdeaprobación");
      const htmlPart = mime.match(/Content-Type: text\/html; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/)![1]!;
      const html = Buffer.from(htmlPart.replace(/\r\n/g, ""), "base64").toString("utf8");
      expect(html).toContain(greeting);
      expect(html).not.toMatch(/76\.921|Valech|S\.p\.A|IVA|\$/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
