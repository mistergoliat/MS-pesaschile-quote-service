/* global process */

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(path.dirname(process.argv[1]), "..");
const sourceDirectory = path.resolve(
  repositoryRoot,
  "src/infrastructure/persistence/postgres/migrations"
);
const destinationDirectory = path.resolve(
  repositoryRoot,
  "dist/infrastructure/persistence/postgres/migrations"
);

if (!fs.existsSync(sourceDirectory) || !fs.statSync(sourceDirectory).isDirectory()) {
  throw new Error(`Migration source directory does not exist: ${sourceDirectory}`);
}

const migrationFiles = fs
  .readdirSync(sourceDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".cjs"))
  .map((entry) => entry.name)
  .sort();

if (migrationFiles.length === 0) {
  throw new Error(`No .cjs migrations found in: ${sourceDirectory}`);
}

fs.mkdirSync(destinationDirectory, { recursive: true });

for (const migrationFile of migrationFiles) {
  fs.copyFileSync(
    path.join(sourceDirectory, migrationFile),
    path.join(destinationDirectory, migrationFile)
  );
}

const missingMigrations = migrationFiles.filter(
  (migrationFile) => !fs.existsSync(path.join(destinationDirectory, migrationFile))
);

if (missingMigrations.length > 0) {
  throw new Error(
    `Migration copy verification failed; missing in dist: ${missingMigrations.join(", ")}`
  );
}

process.stdout.write(`Copied ${migrationFiles.length} migration(s) to dist.\n`);
