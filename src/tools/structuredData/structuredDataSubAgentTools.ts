import { tool, type FileHandle } from "@lmstudio/sdk";
import { z } from "zod";
import { getOrCreateDb, queryAll, getSampleRows } from "../../utils/structuredData/loadStructuredData";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { LIST_TABLES_DESCRIPTION, QUERY_TABLE_DESCRIPTION } from "../../prompts/structuredData";

function bigIntSafe(_key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
        return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }
    return value;
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

// DuckDB table functions that can read/write the host filesystem — legal
// inside a plain SELECT, so the startsWith("select") check alone doesn't
// stop the sub-agent LLM from using them to reach files outside the upload.
const SQL_DENYLIST =
    /\b(read_csv|read_csv_auto|read_json|read_json_auto|read_parquet|read_text|read_blob|glob|sniff_csv|attach|copy|export|import|install|load|pragma_database_list)\b/i;

// Builds the SUB-AGENT's tools (list_tables, query_table) —
// these are what structuredDataSubAgent.ts calls internally, NOT what the main model sees.
export async function buildStructuredDataTools(structuredFiles: FileHandle[], ctl?: PluginCapableCtl) {
    if (structuredFiles.length !== 1) {
        throw new Error("buildStructuredDataTools currently expects exactly one target file.");
    }
    const file = structuredFiles[0];
    const db = await getOrCreateDb(file);

    const listTables = tool({
        name: "list_tables",
        description: LIST_TABLES_DESCRIPTION,
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
            // LLM-bound, but still real wall-clock time on every list_tables call).
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
        name: "query_table",
        description: QUERY_TABLE_DESCRIPTION,
        parameters: {
            sql: z.string(),
        },
        implementation: withLogging("query_table", async ({ sql }) => {
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