import type { FileHandle, PromptPreprocessorController } from "@lmstudio/sdk";
import type { ParsedFile } from "../../../types/types";
import { createDefaultChain } from "./parserIndex";
import { type PluginCapableCtl } from "../../shared/pluginCtl";


const MAX_CACHE_ENTRIES = 50;
// Keyed by file.identifier (unique per upload) rather than path/name, so a
// re-uploaded file with the same name but new content gets its own cache slot
// instead of silently returning the previous upload's parsed text.
export const globalCache = new Map<string, ParsedFile>();
const chain = createDefaultChain();

function cacheParsed(key: string, parsed: ParsedFile): void {
    if (globalCache.size >= MAX_CACHE_ENTRIES && !globalCache.has(key)) {
        const oldestKey = globalCache.keys().next().value;
        if (oldestKey !== undefined) globalCache.delete(oldestKey);
    }
    globalCache.set(key, parsed);
}

export async function parseFile(
    ctl: PluginCapableCtl,
    file: FileHandle,
): Promise<ParsedFile> {
    const cached = globalCache.get(file.identifier);
    if (cached !== undefined) return cached;

    let filePath: string;
    try {
        filePath = await file.getFilePath();
    } catch {
        filePath = file.name;
    }

    const result = await chain.run(file, { ctl, filePath });

    const parsed: ParsedFile = result.success
        ? {
            content: result.content,
            ocrApplied: result.parserName === "ocr-pdf",
            customParsed: result.isCustomExtraction,
        }
        : { content: "", ocrApplied: false, customParsed: false };

    cacheParsed(file.identifier, parsed);

    return parsed;
}