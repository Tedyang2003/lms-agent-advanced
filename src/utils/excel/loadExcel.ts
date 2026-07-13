import * as XLSX from "xlsx";
import * as crypto from "crypto";
import type { AsyncDuckDB, AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import type { FileHandle } from "@lmstudio/sdk";

// A DuckDB-WASM instance plus one persistent connection into it. The instance
// (registerFileText/dropFiles) and the connection (query) are separate handles
// in the WASM API, unlike the native `duckdb` package's single `Database` object
// — bundled together here so call sites can keep passing around "the db" as one value.
export interface DuckHandle {
    db: AsyncDuckDB;
    conn: AsyncDuckDBConnection;
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

async function queryAll(handle: DuckHandle, sql: string): Promise<Record<string, unknown>[]> {
    const table = await handle.conn.query(sql);
    return table.toArray().map((row) => row.toJSON());
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
    let current: GridRow[] = [];
    for (const row of grid) {
        if (isRowBlank(row)) {
            if (current.length > 0) blocks.push(current);
            current = [];
        } else {
            current.push(row);
        }
    }
    if (current.length > 0) blocks.push(current);
    if (blocks.length === 0) return [];

    const tableBlocks: GridRow[][] = [blocks[0]];
    let currentRange = blockColumnRange(blocks[0]);

    for (let i = 1; i < blocks.length; i++) {
        const range = blockColumnRange(blocks[i]);
        if (range[0] === currentRange[0] && range[1] === currentRange[1]) {
            tableBlocks[tableBlocks.length - 1] = tableBlocks[tableBlocks.length - 1].concat(blocks[i]);
        } else {
            tableBlocks.push(blocks[i]);
            currentRange = range;
        }
    }

    return tableBlocks.map((block) => {
        const [min, max] = blockColumnRange(block);
        const firstRow = block[0];
        const firstRowDensity = countNonEmpty(firstRow, min, max);
        const maxDataDensity = Math.max(0, ...block.slice(1).map((r) => countNonEmpty(r, min, max)));

        // Treat the first row as a real header only if it's at least as densely
        // populated as the rows beneath it — a sparser first row (e.g. a lone
        // title cell like "Summary") is a label/title, not a header, so fall
        // back to generic column names and keep it as a data row instead.
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

export async function loadExcelIntoDuckDb(handle: DuckHandle, file: FileHandle): Promise<void> {
    const filePath = await file.getFilePath();
    const workbook = XLSX.readFile(filePath);

    // DuckDB-WASM has no real OS filesystem access — sheet data is staged as
    // JSONL text in its virtual filesystem instead of a real temp file, then
    // dropped once every sheet/table has been loaded into a real table.
    const registeredFiles: string[] = [];

    try {
        for (const sheetName of workbook.SheetNames) {
            const worksheet = workbook.Sheets[sheetName];
            const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
            const rawGrid = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
                header: 1,
                defval: null,
                raw: true,
                blankrows: true, // preserve blank rows — they're the signal used to detect table boundaries
            });
            // sheet_to_json's array output is in row order starting at the sheet's
            // used range, so grid index i corresponds to spreadsheet row range.s.r + i.
            const grid: GridRow[] = rawGrid.map((cells, i) => ({ cells, sourceRow: range.s.r + i + 1 }));

            const baseTableName = sanitizeTableName(sheetName);
            const detectedTables = splitSheetIntoTables(grid);

            for (let tableIndex = 0; tableIndex < detectedTables.length; tableIndex++) {
                const { headers, colOffset, rows } = detectedTables[tableIndex];
                const rawRows = tableRowsFromBlock(headers, colOffset, rows);

                if (rawRows.length === 0) continue; // skip empty sheets, read_json_auto errors on empty input

                // Drop fully-blank rows (common as visual separators in spreadsheets) and
                // trim whitespace on every string cell / header. source_row is attached
                // AFTER the blank check below so it can't itself keep an otherwise-blank
                // row alive (it's always populated, unlike the sheet's real columns).
                const cleanedRows = rawRows
                    .map(({ sourceRow, data }) => {
                        const cleaned: Record<string, unknown> = {};
                        for (const key of Object.keys(data)) {
                            cleaned[sanitizeColumnName(key)] = trimIfString(data[key]);
                        }
                        return { cleaned, sourceRow };
                    })
                    .filter(({ cleaned }) => Object.values(cleaned).some((v) => v !== null && v !== ""))
                    .map(({ cleaned, sourceRow }) => ({ ...cleaned, source_row: sourceRow }));

                if (cleanedRows.length === 0) continue;

                const vpath = `${crypto.randomUUID()}.jsonl`;
                const lines = cleanedRows.map((r) => JSON.stringify(r)).join("\n");
                await handle.db.registerFileText(vpath, lines);
                registeredFiles.push(vpath);

                const tableName = tableIndex === 0 ? baseTableName : `${baseTableName}_${tableIndex + 1}`;
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
            }
        }
    } finally {
        await handle.db.dropFiles(registeredFiles);
    }
}

/** Small helper reused by the tools file to show the model real example rows. */
export async function getSampleRows(
    handle: DuckHandle,
    tableName: string,
    limit = 3
): Promise<Record<string, unknown>[]> {
    return queryAll(handle, `SELECT * FROM "${tableName}" LIMIT ${limit}`);
}