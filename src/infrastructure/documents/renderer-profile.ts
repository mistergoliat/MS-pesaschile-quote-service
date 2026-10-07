import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/*
 * The byte-producing stack of the formal PDF (R1.5B2). Repair (Domain §9.3)
 * must reproduce a recorded pdfSha256, so every input that can change the
 * bytes for the same (document model, template version) is pinned here:
 *
 * - the pdfmake engine and the libraries it lays out and writes with;
 * - the Node major and its bundled zlib: pdfkit deflates content streams and
 *   re-deflates the RGBA logo with node:zlib, so zlib output is part of the bytes;
 * - the embedded font files (by SHA-256).
 *
 * RENDERER_VERSION is derived from this profile and recorded on every
 * manifest. The renderer refuses to start when the running stack differs
 * (readiness then reports renderer_unavailable), and a unit test fails when
 * the lockfile drifts from the profile, so the label can never silently
 * disagree with the bytes. Any change here is a new renderer version.
 */

export const RENDERER_PROFILE = {
  generation: "quote-pdf-r4",
  packages: {
    pdfmake: "0.2.20",
    "@foliojs-fork/pdfkit": "0.15.3",
    "@foliojs-fork/fontkit": "1.9.2",
    "@foliojs-fork/linebreak": "1.1.2",
    "png-js": "1.1.0"
  },
  nodeMajor: 24,
  zlib: "1.3.1-e00f703",
  fontSet: "dejavu-sans-2.37",
  fonts: {
    regular: { file: "DejaVuSans.ttf", sha256: "7da195a74c55bef988d0d48f9508bd5d849425c1770dba5d7bfc6ce9ed848954" },
    bold: { file: "DejaVuSans-Bold.ttf", sha256: "e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724" }
  }
} as const;

const p = RENDERER_PROFILE;

/** e.g. `quote-pdf-r4+pdfmake-0.2.20+pdfkit-0.15.3+node24+zlib-1.3.1-e00f703+dejavu-sans-2.37` (≤ 100 chars, manifest column bound). */
export const RENDERER_VERSION = [
  p.generation,
  `pdfmake-${p.packages.pdfmake}`,
  `pdfkit-${p.packages["@foliojs-fork/pdfkit"]}`,
  `node${p.nodeMajor}`,
  `zlib-${p.zlib}`,
  p.fontSet
].join("+");

const runtimeRequire = createRequire(__filename);

/** Version of an installed package, read from its own package.json (works for packages that do not export it). */
export function installedPackageVersion(name: string): string | null {
  try {
    let directory = path.dirname(runtimeRequire.resolve(name));

    for (let depth = 0; depth < 6; depth += 1) {
      const manifest = path.join(directory, "package.json");

      if (fs.existsSync(manifest)) {
        const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; version?: string };

        if (parsed.name === name) {
          return parsed.version ?? null;
        }
      }

      directory = path.dirname(directory);
    }
  } catch {
    // unresolvable: reported as a mismatch below
  }

  return null;
}

/** Differences between the running stack and the pinned profile (names only, no paths). Empty when it matches. */
export function rendererRuntimeMismatches(versions: NodeJS.ProcessVersions = process.versions): string[] {
  const mismatches: string[] = [];

  for (const [name, expected] of Object.entries(p.packages)) {
    if (installedPackageVersion(name) !== expected) {
      mismatches.push(name);
    }
  }

  if (Number(versions.node.split(".")[0]) !== p.nodeMajor) {
    mismatches.push("node");
  }

  if (versions.zlib !== p.zlib) {
    mismatches.push("zlib");
  }

  return mismatches;
}
