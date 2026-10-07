import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildApplication } from "../../src/app";
import { ISSUANCE_CHECKPOINTS } from "../../src/application/quote-v2/issuance-failpoints";
import { loadEnv } from "../../src/infrastructure/config/env";
import { documentFileName } from "../../src/http/routes/v2-quote-route";
import { importClosure } from "../helpers/import-closure";
import { testRegistryJson } from "../helpers/test-principals";

/*
 * R1.5B4 §34, §35, §33: the test seams accumulated in B1–B4
 * (`disableIssuanceExecution`, `issuanceFailpoints`) are constructor
 * arguments only; production cannot toggle them. Document access and
 * integrity code cannot delete content-addressed artifacts or send email.
 */

const SEAMS = ["disableIssuanceExecution", "issuanceFailpoints", "testMailSender", "disableDeliveryExecution", "deliveryFailpoints"] as const;

function sourceFiles(directory: string): string[] {
  return fs
    .readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => path.relative(process.cwd(), path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
    .sort();
}

const baseEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://user:secret@127.0.0.1:1/none",
  QUOTE_PRINCIPAL_REGISTRY_JSON: testRegistryJson(),
  QUOTE_DOCUMENT_STORAGE_ROOT: "./.unused-storage-root"
};

describe("test seams are not production-toggleable", () => {
  it("only src/app.ts knows the seams; the production entry (src/server.ts) builds without overrides", () => {
    for (const file of sourceFiles("src")) {
      const source = fs.readFileSync(file, "utf8");

      for (const seam of SEAMS) {
        // Only the composition root reads a seam (the failpoint contract file documents it in a comment).
        if (file !== "src/app.ts") {
          expect(source.replace(/\/\*[\s\S]*?\*\//g, ""), `${file} uses ${seam}`).not.toContain(seam);
        }
      }
    }

    const server = fs.readFileSync("src/server.ts", "utf8");
    expect(server.match(/buildApplication\(/g)).toHaveLength(1);
    expect(server).toContain("application = buildApplication(env);");
  });

  it("no environment variable maps to a seam: unknown keys are dropped and only config/env.ts reads process.env in the runtime", () => {
    const env = loadEnv({
      ...baseEnv,
      DISABLE_ISSUANCE_EXECUTION: "true",
      disableIssuanceExecution: "true",
      QUOTE_ISSUANCE_FAILPOINT: "after_claim",
      issuanceFailpoints: "after_claim"
    }) as unknown as Record<string, unknown>;

    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/fail.?point|disable.?issuance|seam/i);
    }

    const runtime = importClosure("src/server.ts").filter((file) => !file.startsWith("src/scripts/"));
    const readers = runtime.filter((file) => /process\.env\b/.test(fs.readFileSync(file, "utf8")));
    expect(readers).toEqual(["src/infrastructure/config/env.ts"]);

    for (const file of runtime) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/process\.argv/);
    }
  });

  it("the default composition runs issuance and has no failpoint route; checkpoints are inert without a test implementation", async () => {
    const context = buildApplication(loadEnv(baseEnv), { logStream: { write: () => undefined } });

    try {
      expect(context.issuance).not.toBeNull();
      await context.app.ready();
      const routes = context.app.printRoutes({ commonPrefix: false });
      expect(routes).not.toMatch(/fail|seam|halt|crash|resume/i);
    } finally {
      await context.app.close();
    }

    // Every failpoint call site is optional chaining on an undefined default.
    for (const file of sourceFiles("src")) {
      const source = fs.readFileSync(file, "utf8");

      for (const match of source.matchAll(/(\w+(?:\.\w+)*)\.reach\(/g)) {
        expect(`${file}: ${match[0]}`).toMatch(/failpoints\?\.reach\(|failpoints\.reach\(/);
      }
    }

    expect(ISSUANCE_CHECKPOINTS).toHaveLength(11);
  });

  it("the failpoint server is test-only: outside the build, outside the runtime image", () => {
    const build = JSON.parse(fs.readFileSync("tsconfig.build.json", "utf8")) as { include: string[]; compilerOptions: { rootDir: string } };
    expect(build.include).toEqual(["src/**/*.ts"]);
    expect(build.compilerOptions.rootDir).toBe("./src");
    expect(fs.existsSync("test/process/failpoint-server.ts")).toBe(true);
    expect(sourceFiles("src").some((file) => fs.readFileSync(file, "utf8").includes("failpoint-server"))).toBe(false);

    const dockerfile = fs.readFileSync("Dockerfile", "utf8");
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtimeStage).not.toMatch(/COPY[^\n]*\btest\b/);
    expect(runtimeStage).toMatch(/CMD \["dumb-init", "--", "node", "dist\/server\.js"\]/);
  });
});

describe("document access and integrity: no deletion of content-addressed artifacts, no email", () => {
  const ENTRIES = [
    "src/http/routes/v2-quote-route.ts",
    "src/infrastructure/documents/document-artifact-verifier.ts",
    "src/scripts/verify-document-artifacts.ts",
    "src/application/quote-v2/issuance-attempt.ts",
    "src/application/quote-v2/issuance-worker.ts",
    "src/infrastructure/runtime/issuance-jobs.ts",
    "src/infrastructure/persistence/postgres/issuance-operations.ts"
  ];

  it("§34: the closure never reaches legacy mutable storage (deleteStorageKey/deletePrefix/writeBuffer)", () => {
    const closure = importClosure(...ENTRIES);

    expect(closure.filter((file) => file.includes("filesystem-document-artifact-storage"))).toEqual([]);

    for (const file of closure) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/deleteStorageKey|deletePrefix|writeBuffer|writeText|\brm\(|rmdir|rename\(/);
    }
  });

  it("§34: in the content-addressed store every unlink targets a temp/probe path, never a final key", () => {
    const source = fs.readFileSync("src/infrastructure/documents/content-addressed-artifact-store.ts", "utf8");
    const unlinks = [...source.matchAll(/unlink\((\w+)\)/g)].map((match) => match[1]);

    expect(unlinks.sort()).toEqual(["entryPath", "linkPath", "probePath", "tempPath"]);
    expect(source).toMatch(/const entryPath = path\.join\(directory, entry\);/);
    expect(source).toMatch(/const directory = this\.resolve\(TEMP_DIRECTORY\);/);
  });

  it("§33 / §78: issuance, document and integrity paths reach no mail sender, no delivery worker and no delivery persistence", () => {
    const closure = importClosure(...ENTRIES, "src/application/quote-v2/inline-issuance.ts", "src/infrastructure/persistence/postgres/quote-v2-acceptance.ts");

    expect(
      closure.filter((file) => /gmail|infrastructure\/email\/|mail-sender-port|delivery-worker|quote-v2-deliveries|quote-v2-delivery-execution|v2-delivery-route|delivery-jobs|email-envelope/.test(file))
    ).toEqual([]);
  });

  it("R1.6B: only the delivery worker calls a mail sender; routes and the request transaction never receive one", () => {
    const runtime = importClosure("src/server.ts");
    const callers = runtime.filter((file) => /\b(?:sender|mailSender)\??\.send\(/.test(fs.readFileSync(file, "utf8")));
    expect(callers).toEqual(["src/application/quote-v2/delivery/delivery-worker.ts"]);

    for (const file of ["src/http/routes/v2-delivery-route.ts", "src/infrastructure/persistence/postgres/quote-v2-deliveries.ts", "src/http/routes/v2-quote-route.ts"]) {
      expect(fs.readFileSync(file, "utf8"), file).not.toMatch(/MailSenderPort|mail-sender-port|GmailMailSender/);
    }

    const app = fs.readFileSync("src/app.ts", "utf8");
    expect(app).toContain('overrides.testMailSender ?? (env.QUOTE_EMAIL_PROVIDER === "gmail" ? new GmailMailSender(gmailSettings(env)) : null)');
  });

  it("R1.6B: no configuration value selects a fake sender or a provider endpoint", () => {
    expect(() => loadEnv({ ...baseEnv, QUOTE_EMAIL_PROVIDER: "fake" })).toThrow();
    const env = loadEnv({ ...baseEnv, QUOTE_EMAIL_FAKE: "true", QUOTE_EMAIL_TOKEN_ENDPOINT: "http://127.0.0.1:1/token" }) as unknown as Record<string, unknown>;

    for (const key of Object.keys(env)) {
      expect(key).not.toMatch(/fake|endpoint/i);
    }

    expect(fs.readFileSync("src/infrastructure/config/env.ts", "utf8")).not.toMatch(/endpoints?:/);
  });

  it("R1.6B: the default composition has no sender and no send runner, but always the persistence sweep", async () => {
    const context = buildApplication(loadEnv(baseEnv), { logStream: { write: () => undefined } });

    try {
      expect(context.mailSender).toBeNull();
      expect(context.delivery?.emailDelivery).toBeNull();
      expect(context.delivery?.deliveryOutcomeSweep).toBeDefined();
      expect(context.backgroundJobs.status()).toMatchObject({ emailDelivery: { enabled: false }, deliveryOutcomeSweep: { enabled: true } });
    } finally {
      await context.app.close();
    }
  });
});

describe("Content-Disposition file name", () => {
  it("is <quoteNumber>.pdf, built from the quote number only and sanitized independently of any path", () => {
    expect(documentFileName("PC-000123")).toBe("PC-000123.pdf");
    expect(documentFileName(null)).toBe("quote.pdf");

    for (const hostile of ['PC-1"; filename="x', "../../etc/passwd", "PC 1", "PC-1\r\nX-Injected: 1", "", "a".repeat(65), "artifacts/sha256/aa/bb/x"]) {
      expect(documentFileName(hostile), hostile).toBe("quote.pdf");
    }
  });
});
