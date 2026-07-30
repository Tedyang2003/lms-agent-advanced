// lms dev --install doesn't carry over every file needed at runtime:
// - eng.traineddata (Tesseract OCR language data) isn't copied at all, since it lives
//   outside node_modules
// - duckdb-wasm's .wasm/.worker.cjs files (dist/) are binary-ish, non-.js assets
//   living inside node_modules — included here on the same suspicion that made
//   duckdb.node (its native-binding predecessor, before the duckdb-wasm migration)
//   get dropped by whatever file-type filtering `lms dev --install` applies.
// - onenote-converter-wasm's renderer_bg.wasm is the same category of asset —
//   included here on the same suspicion, same as duckdb-wasm's .wasm files above.
//   UNVERIFIED: re-run `npm run install-plugin` and confirm both the plugin's Excel
//   tools AND OneNote (.one) parsing still work after a real install before relying
//   on this. If OneNote parsing fails post-install, also check whether
//   snippets/parser-utils-*/node_functions.js survived the install — it's a .js file
//   so it should be fine, but that assumption hasn't been verified for this package.
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
const ONENOTE_WASM_DIST = path.join("node_modules", "@tedyang2003", "onenote-converter-wasm");

const relPaths = [
  path.join(DUCKDB_WASM_DIST, "duckdb-mvp.wasm"),
  path.join(DUCKDB_WASM_DIST, "duckdb-eh.wasm"),
  path.join(DUCKDB_WASM_DIST, "duckdb-node-mvp.worker.cjs"),
  path.join(DUCKDB_WASM_DIST, "duckdb-node-eh.worker.cjs"),
  path.join(ONENOTE_WASM_DIST, "renderer_bg.wasm"),
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
