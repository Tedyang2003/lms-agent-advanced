// Central home for internal size/time limits that were previously duplicated
// or scattered as local magic numbers across the tools/parsers that use them.
// These are implementation limits (memory/resource bounds), not user-facing
// behavior knobs — user-facing tunables (retrieval limit, OCR toggle, etc.)
// belong in config.ts's configSchematics instead.
//
// Sized for this plugin's actual deployment target: a single user per edge
// device, CPU-only, running a small local model — not a shared multi-user
// server. Limits here are deliberately much lower than a generic default
// (e.g. 50) would be, since one user never realistically needs that many
// concurrent conversations/files cached, and every cached entry competes
// with the LLM itself for the same limited CPU/RAM.

// --- Structured data (tools/structuredData/buildStructuredDataTools.ts, buildStructuredDataQueryTool.ts, utils/structuredData/structuredDataPreview.ts) ---

// Max cached DuckDB connections (each holds a live WASM worker thread) — kept
// low since these are the most expensive entries here and a single user
// won't have this many spreadsheets/CSVs/JSON files open at once.
export const STRUCTURED_DATA_DB_CACHE_MAX = 8;

// Max cached per-file schema summaries (query_structured_data's deterministic
// column/warning text). Per-file, not per-conversation, and cheap (plain
// text) — kept higher than STRUCTURED_DATA_DB_CACHE_MAX since a single user
// can reasonably touch more distinct files over a session than they'd have
// open at once.
export const STRUCTURED_DATA_SCHEMA_CACHE_MAX = 20;

// Max cached short table-list previews shown when a spreadsheet/CSV/JSON file is attached.
export const STRUCTURED_DATA_PREVIEW_CACHE_MAX = 20;

// --- Documents (utils/docs/parser/parseFile.ts, utils/docs/retrieval/filePreview.ts) ---

// Max cached parsed-document results (post parser-chain: native/OCR/pptx).
// Kept low: this is the single largest cached payload in the plugin
// (a full OCR'd document can be tens of KB of text), so it's trimmed harder
// than the structured-data caches for a single-user, memory-constrained edge device.
export const DOC_PARSE_CACHE_MAX = 10;

// Max cached short text previews shown when a document is attached.
export const DOC_PREVIEW_CACHE_MAX = 15;

// Char cap on get_full_document_text's response to the doc sub-agent. Lowered
// from a generic default so a single full-text dump doesn't dominate the
// sub-agent's context window / processing time on a slow CPU-only model.
export const DOC_FULL_TEXT_CHAR_CAP = 6000;

// --- OCR fallback (utils/docs/parser/ocrPdfParser.ts) ---

// Below this many recovered characters, OCR is treated as having found
// nothing usable.
export const OCR_MIN_TEXT_LENGTH = 50;

// Hard cap on pages OCR'd per PDF. Lowered from a generic default — OCR is
// CPU-bound and slow on an edge device, so a huge scanned document is capped
// harder to keep worst-case OCR time bounded for a single user waiting on it.
export const OCR_MAX_PAGES = 20;

// Per-page OCR timeout — a hung page fails instead of blocking forever.
export const OCR_PAGE_TIMEOUT_MS = 30_000;

// --- File registry (tools/shared/fileRegistry.ts) ---

// Max distinct conversations (working directories) tracked in total, shared
// across BOTH the structured-data and doc registries, before the least-recently-used
// one is evicted from both. Kept low: a single user on one edge device won't
// have dozens of conversations with file attachments open at once.
export const FILE_REGISTRY_MAX_CONVERSATIONS = 8;
