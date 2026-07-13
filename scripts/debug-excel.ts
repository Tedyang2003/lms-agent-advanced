// debug-excel.ts
import * as readline from "readline";
import { loadExcelIntoDuckDb, type DuckHandle } from "../src/utils/excel/loadExcel";
import { instantiateDuckDb } from "../src/tools/excel/buildExcelTools";

async function main() {
    const filePath = process.argv[2];
    if (!filePath) { console.error("Usage: ts-node debug-excel.ts <path-to-xlsx>"); process.exit(1); }

    const db = await instantiateDuckDb();
    const conn = await db.connect();
    const handle: DuckHandle = { db, conn };
    await loadExcelIntoDuckDb(handle, { name: filePath, getFilePath: async () => filePath } as any);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "sql> " });
    rl.prompt();
    rl.on("line", async (line) => {
        try {
            const table = await conn.query(line);
            console.table(table.toArray().map((row) => row.toJSON()));
        } catch (err) {
            console.error("Error:", (err as Error).message);
        }
        rl.prompt();
    });
}
main();