import { tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { getOrCreateDb, queryAll } from "./buildStructuredDataTools";
import { runStructuredDataSubAgent } from "./structuredDataSubAgent";
import { structuredDataRegistry } from "../shared/fileRegistry";
import { adaptFromTool } from "../../utils/shared/pluginCtl";
import { configSchematics } from "../../config";
import { STRUCTURED_DATA_QUERY_TOOL_DESCRIPTION } from "../../prompts/structuredData";
import { STRUCTURED_DATA_SCHEMA_CACHE_MAX } from "../../constants";

// The schema summary is a deterministic snapshot of the file's structure (columns,
// unit/summary-row warnings) — it doesn't change across repeated questions against
// the same file within a session, so recomputing it via a fresh DuckDB scan on every
// query_structured_data call is pure waste. Keyed the same way as dbCache in buildStructuredDataTools.ts.
const schemaSummaryCache = new Map<string, string>();

function cacheSchemaSummary(key: string, summary: string): void {
    if (schemaSummaryCache.size >= STRUCTURED_DATA_SCHEMA_CACHE_MAX && !schemaSummaryCache.has(key)) {
        const oldestKey = schemaSummaryCache.keys().next().value;
        if (oldestKey !== undefined) schemaSummaryCache.delete(oldestKey);
    }
    schemaSummaryCache.set(key, summary);
}

export function buildStructuredDataQueryTool(ctl: ToolsProviderController) {
    return tool({
        name: "query_structured_data",
        description: STRUCTURED_DATA_QUERY_TOOL_DESCRIPTION,
        parameters: {
            question: z.string().describe("The user's data question, verbatim or lightly cleaned up."),
            fileName: z.string().describe("The exact filename of the spreadsheet/CSV/JSON file to query, e.g. 'npu_vs_cpu_test.xlsx'."),
        },
        implementation: async ({ question, fileName }: { question: string; fileName: string }, toolCtx) => {
            const file = structuredDataRegistry.lookup(ctl.getWorkingDirectory(), fileName);
            if (!file) {
                return (
                    `Error: no file named "${fileName}" is currently registered for this conversation. ` +
                    `It may not have been processed yet, or the name may be slightly off — ask the user ` +
                    `to confirm the exact filename.`
                );
            }

            const adapted = adaptFromTool(ctl, toolCtx, configSchematics);

            let db;
            try {
                db = await getOrCreateDb(file);
            } catch (e) {
                return `Error loading "${fileName}": ${(e as Error).message}`;
            }

            let schemaSummary = schemaSummaryCache.get(file.identifier);
            if (schemaSummary === undefined) {
                try {
                    const tables = await queryAll(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='main'`);
                    // Each table's summary is independent of every other table's —
                    // safe to compute concurrently instead of one at a time.
                    const schemaSummaries = await Promise.all(tables.map(async (t) => {
                        // source_row is provenance metadata (every table has it, explained
                        // once in the sub-agent's system prompt) — excluded here so it doesn't
                        // clutter the column listing or dilute the sparse-row detection below.
                        const cols = (await queryAll(db, `PRAGMA table_info("${t.table_name}")`))
                            .filter((c: any) => c.name !== "source_row");
                        const colDescriptions = cols.map((c: any) => `${c.name} (${c.type})`).join(", ");

                        const textColsWithNumericTwin = cols
                            .filter((c: any) => cols.some((c2: any) => c2.name === `${c.name}_numeric`))
                            .map((c: any) => c.name);

                        const mixedUnitCols = cols
                            .filter((c: any) => cols.some((c2: any) => c2.name === `${c.name}_unit`))
                            .map((c: any) => c.name);

                        let summary = `table "${t.table_name}": columns [${colDescriptions}]`;
                        if (textColsWithNumericTwin.length > 0) {
                            summary +=
                                `\nWARNING: columns [${textColsWithNumericTwin.join(", ")}] are TEXT containing units ` +
                                `(e.g. "18.42 tokens/s"). Sorting/comparing them as strings gives WRONG results ` +
                                `(e.g. "9.50" sorts above "18.42" alphabetically). ` +
                                `ALWAYS use the corresponding "<column>_numeric" column for ORDER BY, MIN, MAX, or any numeric comparison.`;
                        }
                        if (mixedUnitCols.length > 0) {
                            summary +=
                                `\nWARNING: columns [${mixedUnitCols.join(", ")}] mix multiple units within the same ` +
                                `column (e.g. some rows in "ms", others in "s"). Their "_numeric" twin is only the bare ` +
                                `number, NOT unit-normalized — check the corresponding "<column>_unit" column per row ` +
                                `before comparing or aggregating numerically across rows.`;
                        }

                        // Detect trailing summary/total rows (e.g. a "Total"/"Average X" label with
                        // most other columns blank) by comparing each row's populated-column count
                        // against the best-populated row. Computed once here, deterministically, so
                        // the sub-agent gets the real record count as a stated fact instead of having
                        // to infer and correctly encode a NULL-filtering strategy in SQL itself —
                        // small models are unreliable at the latter even when told to do it.
                        const nonNullExpr = cols.map((c: any) => `("${c.name}" IS NOT NULL)::INT`).join(" + ");
                        const [{ total_rows, sparse_rows }] = await queryAll(
                            db,
                            `WITH filled AS (SELECT (${nonNullExpr}) AS non_null_count FROM "${t.table_name}"),
                                  stats AS (SELECT MAX(non_null_count) AS max_fill, COUNT(*) AS total_rows FROM filled)
                             SELECT stats.total_rows AS total_rows,
                                    (SELECT COUNT(*) FROM filled WHERE non_null_count < GREATEST(stats.max_fill / 2.0, 1)) AS sparse_rows
                             FROM stats`,
                        );
                        const sparseCount = Number(sparse_rows);
                        const totalCount = Number(total_rows);
                        if (sparseCount > 0) {
                            summary +=
                                `\nNOTE: ${sparseCount} of ${totalCount} rows in "${t.table_name}" have far fewer ` +
                                `populated columns than the rest (e.g. a "Total"/"Summary"/"Average X" label with ` +
                                `everything else blank) — these look like trailing summary rows, not real records. ` +
                                `The real record count is ${totalCount - sparseCount}, not ${totalCount}. If asked ` +
                                `"how many rows/records," answer ${totalCount - sparseCount} directly and mention ` +
                                `summary rows were excluded — do not run COUNT(*) for this.`;
                        }

                        return summary;
                    }));
                    schemaSummary = schemaSummaries.join("\n");
                    cacheSchemaSummary(file.identifier, schemaSummary);
                } catch (e) {
                    return `Error reading schema for "${fileName}": ${(e as Error).message}`;
                }
            }

            adapted.debug(schemaSummary);
            const { trace, answer } = await runStructuredDataSubAgent(adapted, {
                question,
                targetFiles: [file],
                schemaSummary,
            });

            // Visible to the user only — per docs, status is UI-only unless echoed in the return value.
            if (typeof toolCtx?.status === "function") {
                toolCtx.status(trace);
            }

            // This is what the model actually sees.
            return answer;
        },
    });
}

