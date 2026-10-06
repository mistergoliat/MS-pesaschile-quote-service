/* global process */

// Copies the pinned formal-PDF fonts (and their licence) next to the compiled
// renderer. The renderer resolves them module-relative and verifies their
// SHA-256 at startup, so a missing or altered file makes it unavailable.
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(path.dirname(process.argv[1]), "..");
const relative = "infrastructure/documents/assets/fonts";
const sourceDirectory = path.resolve(repositoryRoot, "src", relative);
const destinationDirectory = path.resolve(repositoryRoot, "dist", relative);
const required = ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "LICENSE-DejaVu.txt"];

fs.mkdirSync(destinationDirectory, { recursive: true });

for (const file of required) {
  const source = path.join(sourceDirectory, file);

  if (!fs.existsSync(source)) {
    throw new Error(`Document asset missing: ${file}`);
  }

  fs.copyFileSync(source, path.join(destinationDirectory, file));
}

process.stdout.write(`Copied ${required.length} document asset(s) to dist.\n`);
