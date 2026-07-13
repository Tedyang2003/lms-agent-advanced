import type { FileHandle } from "@lmstudio/sdk";
import { parseFile } from "../parser/parseFile";
import { type PluginCapableCtl } from "../../shared/pluginCtl";
import { cleanCitationText } from "./prepareRetrieval";
import { DOC_PREVIEW_CACHE_MAX } from "../../../constants";

const previewCache = new Map<string, string>();

function cachePreview(key: string, preview: string): void {
    if (previewCache.size >= DOC_PREVIEW_CACHE_MAX && !previewCache.has(key)) {
        const oldestKey = previewCache.keys().next().value;
        if (oldestKey !== undefined) previewCache.delete(oldestKey);
    }
    previewCache.set(key, preview);
}

export async function makeDocPreview(
    file: FileHandle,
    ctl: PluginCapableCtl,
): Promise<string> {
    // Keyed by identifier (unique per upload), not file.name — two different
    // uploads sharing a filename must not collide or serve each other's preview.
    const cached = previewCache.get(file.identifier);
    if (cached) return cached;

    const parsed = await parseFile(ctl, file);
    const cleaned = cleanCitationText(parsed.content).slice(0, 300);
    cachePreview(file.identifier, cleaned);
    return cleaned;
}