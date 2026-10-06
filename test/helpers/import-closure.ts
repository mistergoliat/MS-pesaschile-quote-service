import fs from "node:fs";
import path from "node:path";

/** Relative-import closure of TypeScript source files, as repository-relative paths. */
export function importClosure(...entries: string[]): string[] {
  const seen = new Set<string>();
  const pending = entries.map((entry) => path.resolve(entry));

  while (pending.length > 0) {
    const file = pending.pop()!;

    if (seen.has(file)) {
      continue;
    }

    seen.add(file);
    const source = fs.readFileSync(file, "utf8");

    for (const match of source.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      const target = path.resolve(path.dirname(file), match[1]!);
      pending.push(fs.existsSync(`${target}.ts`) ? `${target}.ts` : path.join(target, "index.ts"));
    }
  }

  return [...seen].map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/")).sort();
}
