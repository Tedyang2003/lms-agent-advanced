import { tool, type FileHandle } from "@lmstudio/sdk";
import { z } from "zod";
import * as path from "path";
import { pathToFileURL } from "url";
import { AsyncDuckDB, VoidLogger, selectBundle } from "@duckdb/duckdb-wasm";
import Worker from "web-worker";
import { loadExcelIntoDuckDb, getSampleRows, sanitizeTableName, type DuckHandle } from "../../utils/excel/loadExcel";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { LIST_SPREADSHEET_TABLES_DESCRIPTION, QUERY_SPREADSHEET_DESCRIPTION } from "../../prompts/excel";

const MAX_CACHE_ENTRIES = 50;
const dbCache = new Map<string, DuckHandle>();

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

function bigIntSafe(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    return value;
}

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

// Evicts the oldest entry once the cache grows past MAX_CACHE_ENTRIES, closing
// its DuckDB connection/worker so handles don't leak.
function cacheDb(key: string, handle: DuckHandle): void {
    if (dbCache.size >= MAX_CACHE_ENTRIES && !dbCache.has(key)) {
        const oldestKey = dbCache.keys().next().value;
        if (oldestKey !== undefined) {
            const oldest = dbCache.get(oldestKey);
            if (oldest) closeHandle(oldest);
            dbCache.delete(oldestKey);
        }
    }
    dbCache.set(key, handle);
}

function withLogging<T extends (...args: any[]) => Promise<string>>(
    name: string,
    fn: T,
    ctl?: PluginCapableCtl,
): T {
    return (async (...args: Parameters<T>) => {
        ctl?.debug(`[TOOL CALL] ${name}`, JSON.stringify(args[0], null, 2));
        const result = await fn(...args);
        ctl?.debug(`[TOOL RESULT] ${name}`, result.length > 2000 ? result.slice(0, 2000) + "...(truncated)" : result);
        return result;
    }) as T;
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

export async function getOrCreateDb(file: FileHandle): Promise<DuckHandle> {
    const key = cacheKey(file);
    const cached = dbCache.get(key);
    if (cached) return cached;

    const db = await instantiateDuckDb();
    const conn = await db.connect();
    const handle: DuckHandle = { db, conn };
    // loadExcelIntoDuckDb needs external file access (it loads via read_json_auto
    // from a file registered in DuckDB-WASM's virtual filesystem) — so it must
    // run BEFORE we seal the database.
    await loadExcelIntoDuckDb(handle, file);

    // Seal the database before it's ever exposed to LLM-generated SQL. This is the
    // real security boundary for query_spreadsheet: enable_external_access=false
    // makes DuckDB itself refuse ATTACH/COPY/read_csv/read_parquet/etc. regardless
    // of what the SQL text looks like, and lock_configuration=true stops a crafted
    // query from re-enabling it. SQL_DENYLIST below is now defense-in-depth only,
    // not the primary guard — a regex blocklist can't keep up with DuckDB's full
    // function surface.
    await queryAll(handle, "SET enable_external_access=false");
    await queryAll(handle, "SET lock_configuration=true");

    cacheDb(key, handle);
    return handle;
}

export async function queryAll(handle: DuckHandle, sql: string): Promise<Record<string, unknown>[]> {
    const conn = await handle.db.connect();
    try {
        const table = await conn.query(sql);
        return table.toArray().map((row) => row.toJSON());
    } finally {
        await conn.close();
    }
}

// DuckDB table functions that can read/write the host filesystem — legal
// inside a plain SELECT, so the startsWith("select") check alone doesn't
// stop the sub-agent LLM from using them to reach files outside the upload.
const SQL_DENYLIST =
    /\b(read_csv|read_csv_auto|read_json|read_json_auto|read_parquet|read_text|read_blob|glob|sniff_csv|attach|copy|export|import|install|load|pragma_database_list)\b/i;

// Builds the SUB-AGENT's tools (list_spreadsheet_tables, query_spreadsheet) —
// these are what excelSubAgent.ts calls internally, NOT what the main model sees.
export async function buildExcelTools(excelFiles: FileHandle[], ctl?: PluginCapableCtl) {
    if (excelFiles.length !== 1) {
        throw new Error("buildExcelTools currently expects exactly one target file.");
    }
    const file = excelFiles[0];
    const db = await getOrCreateDb(file);

    const listTables = tool({
        name: "list_spreadsheet_tables",
        description: LIST_SPREADSHEET_TABLES_DESCRIPTION,
        parameters: {},
        implementation: async () => {
            const tables = await queryAll(
                db,
                `SELECT table_name FROM information_schema.tables WHERE table_schema='main'`
            );

            // Each table's profile is independent of every other table's, and each
            // column's distinct/null count is independent of every other column's —
            // queryAll opens its own DuckDB connection per call, so these are safe
            // to run concurrently instead of one at a time (pure DB latency, not
            // LLM-bound, but still real wall-clock time on every list_spreadsheet_tables call).
            const out = await Promise.all(tables.map(async (t) => {
                const tableName = t.table_name as string;
                const [sampleRows, allProfiles, [{ total_rows }], [{ exact_dupes }]] = await Promise.all([
                    getSampleRows(db, tableName, 3),
                    queryAll(db, `PRAGMA table_info("${tableName}")`),
                    queryAll(db, `SELECT COUNT(*) AS total_rows FROM "${tableName}"`),
                    queryAll(
                        db,
                        `SELECT (SELECT COUNT(*) FROM "${tableName}") - (SELECT COUNT(*) FROM (SELECT DISTINCT * FROM "${tableName}")) AS exact_dupes`
                    ),
                ]);
                // source_row is provenance metadata (every table has it, explained once in
                // the sub-agent's system prompt), not a real data column — excluded here so
                // it doesn't clutter the schema listing or its trivially-unique distinct_count.
                const profiles = allProfiles.filter((p: any) => p.name !== "source_row");

                const columnProfiles = await Promise.all(profiles.map(async (p) => {
                    const colName = p.name as string;
                    const [{ distinct_count, nulls }] = await queryAll(db,
                        `SELECT COUNT(DISTINCT "${colName}") as distinct_count, COUNT(*) - COUNT("${colName}") as nulls FROM "${tableName}"`
                    );
                    return {
                        name: colName,
                        type: p.type,
                        null_count: Number(nulls),
                        distinct_count: Number(distinct_count),
                        likely_categorical: Number(distinct_count) < Number(total_rows) * 0.5,
                    };
                }));

                return {
                    table: tableName,
                    total_rows: Number(total_rows),
                    exact_duplicate_rows: Number(exact_dupes),
                    columns: columnProfiles,
                    sample_rows: sampleRows,
                };
            }));
            return JSON.stringify(out, bigIntSafe, 2);
        },
    });


    const queryData = tool({
        name: "query_spreadsheet",
        description: QUERY_SPREADSHEET_DESCRIPTION,
        parameters: {
            sql: z.string(),
        },
        implementation: withLogging("query_spreadsheet", async ({ sql }) => {
            const clean = sql.trim().toLowerCase();
            if (!clean.startsWith("select") && !clean.startsWith("with")) {
                return "Error: only SELECT or WITH queries are permitted.";
            }
            if (SQL_DENYLIST.test(sql)) {
                return "Error: this query uses a disallowed function/statement.";
            }
            try {
                const rows = await queryAll(db, sql);
                const truncated = rows.length > 200;
                const notice = truncated
                    ? `NOTE: showing first 200 of ${rows.length} rows — refine the query (add WHERE/LIMIT/aggregation) if you need more.\n\n`
                    : "";
                return notice + JSON.stringify(rows.slice(0, 200), bigIntSafe, 2);
            } catch (e) {
                const message = (e as Error).message;
                const isSchemaError = /column|table|does not exist|not found|binder error/i.test(message);
                if (isSchemaError) {
                    try {
                        const tableMatch = sql.match(/from\s+"?(\w+)"?/i);
                        const tableName = tableMatch?.[1];
                        if (tableName) {
                            const cols = await queryAll(db, `PRAGMA table_info("${tableName}")`);
                            const colList = cols.map(c => `${c.name} (${c.type})`).join(", ");
                            return `SQL error: ${message}\n\n` +
                                `Actual columns in "${tableName}": ${colList}\n\n` +
                                `Retry the query using these exact column names.`;
                        }
                    } catch {
                        // fall through
                    }
                }
                return `SQL error: ${message}`;
            }
        }, ctl),
    });


    return [listTables, queryData];
}