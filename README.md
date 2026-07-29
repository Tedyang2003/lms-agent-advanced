## Agentic RAG & OCR Plugin

An LM Studio plugin that gives the main model **tool-driven, agentic access** to attached spreadsheets and documents — including scanned/flat PDFs — instead of dumping raw file content into the context window.

### Introduction

Earlier versions of this plugin worked by injecting document content directly into the prompt. This version takes a different approach: attachments are registered and briefly announced to the model, and all actual reading, querying, and retrieval happens on demand through dedicated tools, each backed by its own small sub-agent. This keeps the main context window lean, avoids wasting tokens on irrelevant file content, and lets the model decide *if* and *when* a file is actually relevant to the user's question.

### What the Plugin Does

1. **Intercepts incoming messages** that have file attachments (via a prompt preprocessor).
2. **Registers each file** (Excel or document) in a per-conversation, working-directory-scoped registry — no eager parsing or content injection at this stage.
3. **Announces new attachments** to the model with a short preview tag, and reminds it on every turn what files are still available, so files remain reachable many turns later without needing to be re-attached.
4. **Exposes tools**, not automatic behavior — the main model decides whether a question actually requires reading a file, and calls the appropriate tool:
   - `query_excel_data` — hands the question to a SQL-capable sub-agent backed by DuckDB.
   - `query_document_data` — hands the question to a retrieval sub-agent that can semantically search chunks or pull full document text.
   - `list_attached_files` — lets the model re-discover what's attached if it scrolled out of context.
   - `get_datetime` — gives the model the current date/time.
5. **Falls back to OCR automatically** when a PDF has little to no extractable text (e.g. a flat/scanned document), recovering readable text via a local Tesseract pipeline before it ever reaches retrieval.
6. **Caches aggressively** — parsed/OCR'd document text and Excel schema summaries are cached per file for the life of the process, so repeated questions against the same file don't repeat expensive work.

### Features

#### Agentic, Tool-Driven File Access
The main model never receives raw file content by default. It calls a tool with a natural-language question and a filename; a purpose-built sub-agent handles the actual file interaction and returns a synthesized answer.

#### Excel Sub-Agent (DuckDB-backed)
Spreadsheets (`.xlsx`, `.xls`, `.xlsm`) are loaded into an in-memory DuckDB database. The sub-agent gets a deterministic schema summary — including warnings for text columns hiding numeric units, mixed-unit columns, and trailing "Total"/"Summary" rows — so it writes correct SQL instead of guessing.

#### Document Sub-Agent (Semantic Retrieval + Full-Text)
Documents are handled by a chain of parsers (LM Studio's native parser, a dedicated PPTX parser, and an OCR fallback for scanned PDFs). The sub-agent chooses between `search_document_chunks` (semantic vector search) for targeted questions and `get_full_document_text` for summarization/overview questions.

#### Intelligent OCR Fallback
Scans the extractable text length of ingested PDFs. If a document looks like a flat image or scanned file, it triggers a local OCR pipeline (Tesseract) to recover the text before it's parsed or embedded.

#### Hybrid Retrieval Engine
Combines LM Studio's native document retrieval with a custom embedding pipeline (using the Nomic embedding model by default) for files that only our own parser chain — not the SDK's native retriever — can see, such as OCR-recovered or PPTX content.

#### Persistent Module-Scoped Cache
A file-path-keyed memory map caches extracted text, Excel schemas, and DuckDB connections across an entire chat session. Documents are parsed and OCR'd exactly once, eliminating redundant lag on subsequent turns.

#### Clarifying Questions
Sub-agents can ask the user a clarifying question via a dedicated tool call (rather than a fragile string-prefix convention) when a query is ambiguous, instead of guessing.

#### Configurable Behavior
Exposed via the plugin's config panel in LM Studio:
- **Retrieval Limit** — max chunks returned per retrieval call.
- **Retrieval Affinity Threshold** — minimum similarity score for a chunk to be considered relevant.
- **Enable OCR Fallback** — toggle OCR recovery for scanned/flat PDFs.
- **Embedding Model** — the model identifier used for document retrieval embeddings (must already be downloaded in LM Studio).

### Set Up Procedure

**Prerequisites**
- [LM Studio](https://lmstudio.ai/) installed, with the `lms` CLI available on your `PATH`.
- [Node.js](https://nodejs.org/) (for `npm install` and running the build/dev scripts).
- An embedding model available in LM Studio matching the configured `embeddingModel` (default: `nomic-ai/nomic-embed-text-v1.5-GGUF`).
- `eng.traineddata` (Tesseract's English OCR language data) present at the project root. This file is intentionally excluded from git (see `.gitignore`) due to its size — obtain it separately and place it in the repo root before installing, or the OCR fallback will not work.

**Steps**

1. Clone the repository and install dependencies:
   ```bash
   git clone https://github.com/Tedyang2003/lms-agent-advanced.git
   cd lms-agent-advanced
   npm install
   ```
2. Place `eng.traineddata` in the project root if it isn't already present.
3. Run the plugin in dev mode (auto-reloads on changes):
   ```bash
   npm run dev
   ```
   or install it into LM Studio directly:
   ```bash
   npm run install-plugin
   ```
   This runs `lms dev --install -y` and then `scripts/fix-install-assets.js`, which copies runtime assets that `lms dev --install` doesn't carry over on its own (DuckDB WASM binaries and `eng.traineddata`) into the installed plugin's directory.
4. Open LM Studio, attach a spreadsheet or document to a chat, and ask a question about it. The model will call the appropriate tool automatically when relevant.
5. To push local changes to LM Studio's plugin registry (if you have publishing access):
   ```bash
   npm run push
   ```
