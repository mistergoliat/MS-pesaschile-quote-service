/* global process */

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(path.dirname(process.argv[1]), "..");
const sourceDirectory = path.resolve(
  repositoryRoot,
  "src/infrastructure/branding/assets/files"
);
const destinationDirectory = path.resolve(
  repositoryRoot,
  "dist/infrastructure/branding/assets/files"
);

if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
  throw new Error(`Brand asset source directory does not exist: ${sourceDirectory}`);
}

const assetFiles = fs
  .readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".png"))
  .map((entry) => entry.name)
  .sort();

if (assetFiles.length === 0) {
  throw new Error(`No .png brand assets found in: ${sourceDirectory}`);
}

fs.mkdirSync(destinationDirectory, { recursive: true });

for (const assetFile of assetFiles) {
  fs.copyFileSync(
    path.join(sourceDirectory, assetFile),
    path.join(destinationDirectory, assetFile)
  );
}

const missingAssets = assetFiles.filter(
  (assetFile) => !fs.existsSync(path.join(destinationDirectory, assetFile))
);

if (missingAssets.length > 0) {
  throw new Error(
    `Brand asset copy verification failed; missing in dist: ${missingAssets.join(", ")}`
  );
}

process.stdout.write(`Copied ${assetFiles.length} brand asset(s) to dist.\n`);
