import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { oneNoteParser } from "../src/utils/docs/parser/oneNoteParser";

const testDataDir = "D:/Projects/CustomPackages/onenote-converter/test-data/School Notes Sample";
const outputDir = "D:/Projects/SAIC/SNIP/plugin_dev/agents-advanced-v1/test-outputs";

const mockCtx = {
    ctl: {
        debug: (...args: any[]) => console.log("[debug]", ...args),
    },
} as any;

async function main() {
    const oneFiles = readdirSync(testDataDir).filter((f) => f.endsWith(".one"));

    for (const file of oneFiles) {
        const mockFile = {
            name: file,
            getFilePath: async () => path.join(testDataDir, file),
        } as any;

        console.log(`\n=== ${file} ===`);
        const result = await oneNoteParser.parse(mockFile, mockCtx);
        console.log("success:", result.success);

        if (result.success) {
            const outPath = path.join(outputDir, `onenote-${path.basename(file, ".one")}.md`);
            writeFileSync(outPath, result.content);
            console.log("wrote:", outPath);
        } else {
            console.log("reason:", result.reason);
        }
    }
}

main();
