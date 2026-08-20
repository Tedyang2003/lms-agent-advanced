import * as XLSX from "xlsx";
import * as crypto from "crypto";
import * as path from "path";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "url";
import { AsyncDuckDB, VoidLogger, selectBundle, type AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import Worker from "web-worker";
import type { FileHandle } from "@lmstudio/sdk";
import { STRUCTURED_DATA_DB_CACHE_MAX } from "../../constants";

// A DuckDB-WASM instance plus one persistent connection into it. The instance
// (registerFileText/dropFiles) and the connection (query) are separate handles
// in the WASM API, unlike the native `duckdb` package's single `Database` object
// — bundled together here so call sites can keep passing around "the db" as one value.
export interface DuckHandle {
    db: AsyncDuckDB;
    conn: AsyncDuckDBConnection;
}

// DuckDB-WASM's local bundle files — resolved once at module scope (cheap path
// math, no WASM loaded yet). MANUAL_BUNDLES (not getJsDelivrBundles()) keeps
// bundle selection fully offline, since this plugin has to run in locked-down
// environments with no outbound network access.
const DUCKDB_DIST = path.dirname(require.resolve("@duckdb/duckdb-wasm"));
const MANUAL_BUNDLES = {
    mvp: {
        mainModule: path.resolve(DUCKDB_DIST, "duckdb-mvp.wasm"),
        mainWorker: path.resolve(DUCKDB_DIST, "duckdb-node-mvp.worker.cjs"),
    },
    eh: {
        mainModule: path.resolve(DUCKDB_DIST, "duckdb-eh.wasm"),
        mainWorker: path.resolve(DUCKDB_DIST, "duckdb-node-eh.worker.cjs"),
    },
};

// Instantiates a fresh DuckDB-WASM engine (its own worker thread + compiled
// .wasm module), lazily, on first actual query rather than at plugin module-load
// time. The .wasm module is a multi-MB payload — eagerly loading it up front
// would block the whole plugin's tool registration (the "loading tools..."
// sidebar UI) the same way duckdb.node's native load used to before this
// migration. mupdf already gets this same lazy treatment in ocrPdfParser.ts for
// the same reason.
export async function instantiateDuckDb(): Promise<AsyncDuckDB> {
    const bundle = await selectBundle(MANUAL_BUNDLES);
    if (!bundle.mainWorker) throw new Error("DuckDB-WASM bundle selection returned no worker script.");
    // `type: "module"` sidesteps a Windows-path bug shared by the `web-worker`
    // polyfill and duckdb-wasm's own bundled copy of it: their classic-worker
    // code path runs the absolute worker path through `path.posix.normalize()`
    // before treating it as a URL, which mangles "C:\..." paths and throws
    // "The URL must be of scheme file". The ESM dynamic-import path instead
    // round-trips it through `pathToFileURL` correctly.
    const worker = new Worker(pathToFileURL(bundle.mainWorker).href, { type: "module" });
    const db = new AsyncDuckDB(new VoidLogger(), worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
}

const dbCache = new Map<string, DuckHandle>();

function cacheKey(file: FileHandle): string {
    return file.identifier;
}

// Closes a handle's connection then terminates its worker/WASM instance. Fire-
// and-forget (not awaited by callers) — same as the eviction path before this
// migration, which didn't wait on `.close()` either.
function closeHandle(handle: DuckHandle): void {
    handle.conn.close()
        .then(() => handle.db.terminate())
        .catch(() => {});
}

// Evicts the oldest entry once the cache grows past STRUCTURED_DATA_DB_CACHE_MAX,
// closing its DuckDB connection/worker so handles don't leak.
function cacheDb(key: string, handle: DuckHandle): void {
    if (dbCache.size >= STRUCTURED_DATA_DB_CACHE_MAX && !dbCache.has(key)) {
        const oldestKey = dbCache.keys().next().value;
        if (oldestKey !== undefined) {
            const oldest = dbCache.get(oldestKey);
            if (oldest) closeHandle(oldest);
            dbCache.delete(oldestKey);
        }
    }
    dbCache.set(key, handle);
}

// Closes every cached DuckDB connection and clears the cache. Called on process
// shutdown (see index.ts) so the plugin process can exit on its own promptly
// instead of relying on LM Studio's forced-kill fallback, which needs a shell
// and can fail in locked-down environments (e.g. AppLocker blocking cmd.exe).
export async function closeAllDatabases(): Promise<void> {
    const closes = Array.from(dbCache.values()).map(async (handle) => {
        await handle.conn.close();
        await handle.db.terminate();
    });
    dbCache.clear();
    await Promise.all(closes);
}

export function sanitizeTableName(name: string): string {
    let clean = name.replace(/[^a-zA-Z0-9_]/g, "_");
    if (/^[0-9]/.test(clean)) clean = "t_" + clean; // table names can't start with a digit
    return clean;
}


function sanitizeColumnName(name: string): string {
    const trimmed = name.trim();
    let clean = trimmed.replace(/[^a-zA-Z0-9_]/g, "_");
    if (/^[0-9]/.test(clean)) clean = "c_" + clean;
    return clean || "column";
}

async function run(handle: DuckHandle, sql: string): Promise<void> {
    await handle.conn.query(sql);
}

// Opens its own connection per call (rather than reusing handle.conn) so
// concurrent callers (e.g. list_tables profiling multiple columns at once)
// don't serialize against each other or leave stray transaction state behind.
export async function queryAll(handle: DuckHandle, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await handle.db.connect();
    try {
        const table = await conn.query(sql);
        return table.toArray().map((row) => row.toJSON());
    } finally {
        await conn.close();
    }
}

/** Trims a string value; leaves non-strings untouched. */
function trimIfString(v: unknown): unknown {
    return typeof v === "string" ? v.trim() : v;
}

/** True if every non-null value in the sample looks like "<number><optional unit>",
 *  e.g. "4,583.14 ms", "9.50 tokens/s", "12". Accepts comma thousands separators.
 *  Empty/all-null columns return false. */
function looksNumericWithUnit(values: unknown[]): boolean {
    const numWithUnit = /^-?\d{1,3}(,\d{3})*(\.\d+)?\s*[a-zA-Z/%]*$/;
    let sawValue = false;
    for (const v of values) {
        if (v === null || v === undefined || v === "") continue;
        if (typeof v !== "string") return false;
        sawValue = true;
        if (!numWithUnit.test(v.trim())) return false;
    }
    return sawValue;
}

/** Extracts the trailing unit suffix from a "<number><unit>" string, e.g. "ms" from "120 ms". */
function extractUnit(v: unknown): string {
    if (typeof v !== "string") return "";
    const match = v.trim().match(/[a-zA-Z/%]+$/);
    return match ? match[0] : "";
}

/** True if the sample contains more than one distinct non-empty unit suffix — e.g. some
 *  rows in "ms", others in "s" — which the bare-number "_numeric" extraction can't tell apart. */
function hasMixedUnits(values: unknown[]): boolean {
    const units = new Set(
        values
            .filter((v): v is string => typeof v === "string" && v.trim() !== "")
            .map(extractUnit)
            .filter(u => u !== ""),
    );
    return units.size > 1;
}

function extractNumber(v: unknown): number | null {
    if (typeof v !== "string") return null;
    const match = v.trim().match(/-?\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : null;
}

// Carries each row's original 1-indexed spreadsheet row number alongside its
// cells, so it can survive table-splitting and end up as a source_row column
// — lets a user trace a result back to the exact row in the original file.
interface GridRow {
    cells: unknown[];
    sourceRow: number;
}

function isCellEmpty(v: unknown): boolean {
    return v === null || v === undefined || v === "";
}

function isRowBlank(row: GridRow): boolean {
    return row.cells.length === 0 || row.cells.every(isCellEmpty);
}

/** [minCol, maxCol] of non-empty cells in a row, or null if the row is fully blank. */
function rowColumnRange(row: GridRow): [number, number] | null {
    let min = -1, max = -1;
    for (let i = 0; i < row.cells.length; i++) {
        if (!isCellEmpty(row.cells[i])) {
            if (min === -1) min = i;
            max = i;
        }
    }
    return min === -1 ? null : [min, max];
}


// Get the column range for a block
function blockColumnRange(block: GridRow[]): [number, number] {
    let min = Infinity, max = -Infinity;
    for (const row of block) {
        const r = rowColumnRange(row);
        if (r) {
            min = Math.min(min, r[0]);
            max = Math.max(max, r[1]);
        }
    }
    return [min, max];
}

function countNonEmpty(row: GridRow, min: number, max: number): number {
    let n = 0;
    for (let i = min; i <= max; i++) if (!isCellEmpty(row.cells[i])) n++;
    return n;
}

/**
 * Splits a sheet's raw grid into one or more independent tables. A run of blank
 * rows only starts a NEW table when the rows after it occupy a different column
 * range than the table so far — e.g. a small summary block sitting below the
 * main data in just columns A-B. Blank rows used purely as visual grouping
 * within one consistently-shaped table (same columns throughout, as in a sheet
 * that just groups related rows) keep merging into that same table, matching
 * the sheet's actual single-table intent.
 */
function splitSheetIntoTables(grid: GridRow[]): { headers: string[]; colOffset: number; rows: GridRow[] }[] {
    const blocks: GridRow[][] = [];
    
    // Current is a temporary holding space that contains a table block in question
    let current: GridRow[] = [];

    // For each row of the grid, keep building the same current table block in question. 
    // When you meet a fully blank row, if there is data in the current block, 
    // push the block to the blocks array and reset current 
    for (const row of grid) {
        if (isRowBlank(row)) {
            if (current.length > 0) blocks.push(current);
            current = [];
        } else {
            current.push(row);
        }
    }

    // Push anything that remains in current after the loop ends
    if (current.length > 0) blocks.push(current);

    // If there are no blocks return empty array
    if (blocks.length === 0) return [];

    
    // Start with the first raw block
    const tableBlocks: GridRow[][] = [blocks[0]];
    
    // Get the current block range
    let currentRange = blockColumnRange(blocks[0]);

    // For each subsequent block, check if its column range matches the current block's range.
    for (let i = 1; i < blocks.length; i++) {
        const range = blockColumnRange(blocks[i]);
        if (range[0] === currentRange[0] && range[1] === currentRange[1]) {
            tableBlocks[tableBlocks.length - 1] = tableBlocks[tableBlocks.length - 1].concat(blocks[i]);
        } else {
            tableBlocks.push(blocks[i]);
            currentRange = range;
        }
    }

    // Return the table blocks with headers and rows, 
    // determining if the first row is a real header or just a title/label row based on 
    // its density compared to the rows below it.
    return tableBlocks.map((block) => {
        const [min, max] = blockColumnRange(block);
        const firstRow = block[0];
        const firstRowDensity = countNonEmpty(firstRow, min, max);
        const maxDataDensity = Math.max(0, ...block.slice(1).map((r) => countNonEmpty(r, min, max)));

        const hasRealHeader = firstRowDensity >= maxDataDensity;
        const headers: string[] = [];
        for (let c = min; c <= max; c++) {
            headers.push(hasRealHeader ? String(firstRow.cells[c] ?? `column_${c - min + 1}`) : `column_${c - min + 1}`);
        }

        return { headers, colOffset: min, rows: hasRealHeader ? block.slice(1) : block };
    });
}

function tableRowsFromBlock(
    headers: string[],
    colOffset: number,
    rows: GridRow[],
): { sourceRow: number; data: Record<string, unknown> }[] {
    return rows.map((row) => {
        const data: Record<string, unknown> = {};
        headers.forEach((h, i) => {
            data[h] = row.cells[colOffset + i] ?? null;
        });
        return { sourceRow: row.sourceRow, data };
    });
}

/**
 * Cleans, loads, and indexes one table's worth of row objects into DuckDB —
 * shared by every loader (Excel/CSV's per-sheet tables, JSON's single table)
 * so the blank-row filtering, source_row provenance, and numeric-unit-column
 * derivation logic lives in exactly one place.
 */
async function insertRowsAsTable(
    handle: DuckHandle,
    tableName: string,
    rawRows: { sourceRow: number; data: Record<string, unknown> }[],
): Promise<void> {
    if (rawRows.length === 0) return; // nothing to load, read_json_auto errors on empty input

    // Drop fully-blank rows (common as visual separators in spreadsheets) and
    // trim whitespace on every string cell / header. source_row is attached
    // AFTER the blank check below so it can't itself keep an otherwise-blank
    // row alive (it's always populated, unlike the source's real columns).
    const cleanedRows: Record<string, unknown>[] = rawRows
        .map(({ sourceRow, data }) => {
            const cleaned: Record<string, unknown> = {};
            for (const key of Object.keys(data)) {
                cleaned[sanitizeColumnName(key)] = trimIfString(data[key]);
            }
            return { cleaned, sourceRow };
        })
        .filter(({ cleaned }) => Object.values(cleaned).some((v) => v !== null && v !== ""))
        .map(({ cleaned, sourceRow }) => ({ ...cleaned, source_row: sourceRow }));

    if (cleanedRows.length === 0) return;

    // DuckDB-WASM has no real OS filesystem access — row data is staged as
    // JSONL text in its virtual filesystem instead of a real temp file, then
    // dropped once loaded into a real table.
    const vpath = `${crypto.randomUUID()}.jsonl`;
    const lines = cleanedRows.map((r) => JSON.stringify(r)).join("\n");
    await handle.db.registerFileText(vpath, lines);

    try {
        await run(handle, `CREATE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${vpath}')`);

        // For any text column that's uniformly "<number><unit>" (e.g. "4583.14 ms",
        // "9.50 tokens/s"), add a derived DOUBLE column so the model can sort/aggregate
        // numerically instead of doing string comparisons on unit-suffixed text.
        const columnNames = Object.keys(cleanedRows[0]).filter((c) => c !== "source_row");
        for (const col of columnNames) {
            const sampleValues = cleanedRows.map((r) => r[col]);
            if (!looksNumericWithUnit(sampleValues)) continue;

            const numericCol = `${col}_numeric`;
            await run(handle, `ALTER TABLE "${tableName}" ADD COLUMN "${numericCol}" DOUBLE`);

            // Update row by row using rowid-free approach: rebuild via a CASE-free
            // UPDATE using regexp_extract, which DuckDB supports natively and is
            // both correct and fast (no need to loop in JS). Thousands separators
            // are stripped first since regexp_extract only pulls the numeric part.
            await run(
                handle,
                `UPDATE "${tableName}"
                 SET "${numericCol}" = TRY_CAST(regexp_extract(replace("${col}", ',', ''), '-?[0-9]+(\\.[0-9]+)?') AS DOUBLE)`
            );

            // If the column mixes units (some rows "ms", others "s"), the bare
            // "_numeric" value alone is numerically valid but semantically wrong to
            // compare across rows — add a "_unit" twin so the model can check it.
            if (hasMixedUnits(sampleValues)) {
                const unitCol = `${col}_unit`;
                await run(handle, `ALTER TABLE "${tableName}" ADD COLUMN "${unitCol}" VARCHAR`);
                await run(
                    handle,
                    `UPDATE "${tableName}"
                     SET "${unitCol}" = regexp_extract("${col}", '[a-zA-Z/%]+$')`
                );
            }
        }
    } finally {
        await handle.db.dropFiles([vpath]);
    }
}

/** Handles .xlsx/.xls/.xlsm/.csv — the `xlsx` library parses CSV into the same
 *  worksheet shape as a real workbook, so no separate CSV-specific path is needed. */
export async function loadWorkbookIntoDuckDb(handle: DuckHandle, file: FileHandle): Promise<void> {
    const filePath = await file.getFilePath();
    const workbook = XLSX.readFile(filePath);

    for (const sheetName of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheetName];
        const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
        const rawGrid = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
            header: 1,  // Header 1 means return it as a list, not that the first row is an actual header — we handle that ourselves in splitSheetIntoTables().
            defval: null, // Keep null values for empty cells 
            raw: true, // Return raw values (numbers, dates, etc.) instead of converting to strings
            blankrows: true, // preserve blank rows — they're the signal used to detect table boundaries
        });
        // sheet_to_json's array output is in row order starting at the sheet's
        // used range, so grid index i corresponds to spreadsheet row range.s.r + i.
       
        // Attach the original 1-indexed spreadsheet row number
        const grid: GridRow[] = rawGrid.map((cells, i) => ({ cells, sourceRow: range.s.r + i + 1 }));

        // Clean the table name to be a valid DuckDB Table name
        const baseTableName = sanitizeTableName(sheetName);

        // Split a single sheet into individual tables based on blank rows and column ranges
        const detectedTables = splitSheetIntoTables(grid);

        // Load each detected table into DuckDB, naming them baseTableName, baseTableName_2, baseTableName_3, etc.
        for (let tableIndex = 0; tableIndex < detectedTables.length; tableIndex++) {
            const { headers, colOffset, rows } = detectedTables[tableIndex];
            const rawRows = tableRowsFromBlock(headers, colOffset, rows);
            const tableName = tableIndex === 0 ? baseTableName : `${baseTableName}_${tableIndex + 1}`;
            await insertRowsAsTable(handle, tableName, rawRows);
        }
    }
}

/** Handles .json — expects a top-level array of flat objects (a single object is
 *  treated as a one-row array). Nested/non-tabular JSON is rejected with a clear
 *  error rather than silently producing a nonsensical table. */
export async function loadJsonIntoDuckDb(handle: DuckHandle, file: FileHandle): Promise<void> {
    const filePath = await file.getFilePath();
    const text = await readFile(filePath, "utf-8");

    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error(`"${file.name}" is not valid JSON: ${(e as Error).message}`);
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length === 0) {
        throw new Error(`"${file.name}" contains an empty array — nothing to load.`);
    }
    const nonObjectIndex = items.findIndex(
        (item) => typeof item !== "object" || item === null || Array.isArray(item),
    );
    if (nonObjectIndex !== -1) {
        throw new Error(
            `"${file.name}" must be a flat array of objects (or a single object) to be queried as a ` +
            `table — element ${nonObjectIndex} is not a plain object.`,
        );
    }

    const rawRows = items.map((data, i) => ({ sourceRow: i + 1, data: data as Record<string, unknown> }));
    const tableName = sanitizeTableName(file.name.replace(/\.json$/i, ""));
    await insertRowsAsTable(handle, tableName, rawRows);
}

/** Dispatches to the right loader by extension — the single entry point tools should call. */
export async function loadStructuredDataIntoDuckDb(handle: DuckHandle, file: FileHandle): Promise<void> {
    if (file.name.toLowerCase().endsWith(".json")) {
        return loadJsonIntoDuckDb(handle, file);
    }
    return loadWorkbookIntoDuckDb(handle, file);
}

// Looks up (or lazily creates) the cached DuckDB handle for one uploaded file —
// the single entry point every structured-data caller (sub-agent tools, the
// query_structured_data tool, and the attachment preview) should go through.
export async function getOrCreateDb(file: FileHandle): Promise<DuckHandle> {
    const key = cacheKey(file);
    const cached = dbCache.get(key);
    if (cached) return cached;

    const db = await instantiateDuckDb();
    const conn = await db.connect();
    const handle: DuckHandle = { db, conn };
    // loadStructuredDataIntoDuckDb needs external file access (it loads via
    // read_json_auto from a file registered in DuckDB-WASM's virtual
    // filesystem) — so it must run BEFORE we seal the database.
    await loadStructuredDataIntoDuckDb(handle, file);

    // Seal the database before it's ever exposed to LLM-generated SQL. This is the
    // real security boundary for query_table: enable_external_access=false
    // makes DuckDB itself refuse ATTACH/COPY/read_csv/read_parquet/etc. regardless
    // of what the SQL text looks like, and lock_configuration=true stops a crafted
    // query from re-enabling it. SQL_DENYLIST in structuredDataSubAgentTools.ts is
    // now defense-in-depth only, not the primary guard — a regex blocklist can't
    // keep up with DuckDB's full function surface.
    await queryAll(handle, "SET enable_external_access=false");
    await queryAll(handle, "SET lock_configuration=true");

    cacheDb(key, handle);
    return handle;
}

/** Small helper reused by the tools file to show the model real example rows. */
export async function getSampleRows(
    handle: DuckHandle,
    tableName: string,
    limit = 3
): Promise<Record<string, unknown>[]> {
    return queryAll(handle, `SELECT * FROM "${tableName}" LIMIT ${limit}`);
}