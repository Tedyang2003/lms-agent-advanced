// lms dev --install doesn't carry over every file needed at runtime:
// - eng.traineddata (Tesseract OCR language data) isn't copied at all, since it lives
//   outside node_modules
// - duckdb-wasm's .wasm/.worker.cjs files (dist/) are binary-ish, non-.js assets
//   living inside node_modules — included here on the same suspicion that made
//   duckdb.node (its native-binding predecessor, before the duckdb-wasm migration)
//   get dropped by whatever file-type filtering `lms dev --install` applies.
//   UNVERIFIED: re-run `npm run install-plugin` and confirm the plugin's Excel
//   tools still work after a real install before relying on this.
// This restores all of it after every install so the plugin doesn't crash/misbehave at runtime.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"),
);

const lmsPath = execSync("where lms", { encoding: "utf8" }).trim().split(/\r?\n/)[0];
const lmStudioRoot = path.dirname(path.dirname(lmsPath)); // .../bin/lms.exe -> ...

const installDir = path.join(
  lmStudioRoot,
  "extensions",
  "plugins",
  manifest.owner,
  manifest.name,
);

if (!fs.existsSync(installDir)) {
  console.log(`[fix-install-assets] Install dir not found (${installDir}), skipping.`);
  process.exit(0);
}

const DUCKDB_WASM_DIST = path.join("node_modules", "@duckdb", "duckdb-wasm", "dist");

const relPaths = [
  path.join(DUCKDB_WASM_DIST, "duckdb-mvp.wasm"),
  path.join(DUCKDB_WASM_DIST, "duckdb-eh.wasm"),
  path.join(DUCKDB_WASM_DIST, "duckdb-node-mvp.worker.cjs"),
  path.join(DUCKDB_WASM_DIST, "duckdb-node-eh.worker.cjs"),
  "eng.traineddata",
];

for (const relPath of relPaths) {
  const source = path.join(__dirname, "..", relPath);
  const dest = path.join(installDir, relPath);

  if (!fs.existsSync(source)) {
    console.error(`[fix-install-assets] Source missing, skipping: ${source}`);
    continue;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  console.log(`[fix-install-assets] Copied ${relPath} -> ${dest}`);
}
