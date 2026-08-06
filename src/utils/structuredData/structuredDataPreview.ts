import type { FileHandle } from "@lmstudio/sdk";
import { getOrCreateDb, queryAll } from "../../tools/structuredData/structuredDataAgentTools";
import { STRUCTURED_DATA_PREVIEW_CACHE_MAX } from "../../constants";

const previewCache = new Map<string, string>();

function cachePreview(key: string, preview: string): void {
    if (previewCache.size >= STRUCTURED_DATA_PREVIEW_CACHE_MAX && !previewCache.has(key)) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey !== undefined) previewCache.delete(oldestKey);
    }
    previewCache.set(key, preview);
}

export async function makeStructuredDataPreview(file: FileHandle): Promise<string> {
    // Keyed by identifier (unique per upload), not file.name — two different
    // uploads sharing a filename must not collide or serve each other's preview.
    const cached = previewCache.get(file.identifier);
    if (cached) return cached;

    const db = await getOrCreateDb(file);
    const tables = await queryAll(db, `SELECT table_name FROM information_schema.tables WHERE table_schema='main'`);
    const parts = await Promise.all(
        tables.map(async (t: any) => {
            const cols = await queryAll(db, `PRAGMA table_info("${t.table_name}")`);
            return `${t.table_name}(${cols.map((c: any) => c.name).join(", ")})`;
        })
    );
    const preview = `Tables: ${parts.join("; ")}`;
    cachePreview(file.identifier, preview);
    return preview;
}
