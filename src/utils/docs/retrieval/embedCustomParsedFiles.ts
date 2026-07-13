import {
    type EmbeddingDynamicHandle,
    type FileHandle,
} from "@lmstudio/sdk";
import { globalCache } from "../parser/parseFile";
import type { CustomParsedScoredEntry } from "../../../types/types";
import { cosineSimilarity } from "./similarity";
import { chunkText } from './chunkText';
import { type PluginCapableCtl } from "../../../utils/shared/pluginCtl";

export async function embedCustomParsedFiles(
    ctl: PluginCapableCtl,
    originalUserPrompt: string,
    customFiles: Array<{ file: FileHandle; content: string }>,
    embeddingModel: EmbeddingDynamicHandle,
): Promise<CustomParsedScoredEntry[]> {
    if (customFiles.length === 0) return [];

    const { embedding: queryEmbedding } = await embeddingModel.embed(originalUserPrompt);
    const scoredEntries: CustomParsedScoredEntry[] = [];

    for (const { file, content } of customFiles) {
        // Cache is owned by parseFile.ts, keyed by file.identifier.
        const cachedFileEntry = globalCache.get(file.identifier);

        if (cachedFileEntry) {
            // Chunk embeddings are computed once per file and stored back onto this
            // same cache entry, so repeated queries against this file reuse them.
            if (!cachedFileEntry.cachedChunks) {
                const chunks = chunkText(content);
                if (chunks.length > 0) {
                    const chunkEmbeddings = await embeddingModel.embed(chunks);
                    cachedFileEntry.cachedChunks = chunks.map((chunk, index) => ({
                        chunk,
                        embedding: chunkEmbeddings[index].embedding,
                    }));
                } else {
                    cachedFileEntry.cachedChunks = [];
                }
            }

            for (const cached of cachedFileEntry.cachedChunks) {
                scoredEntries.push({
                    content: cached.chunk,
                    score: cosineSimilarity(queryEmbedding, cached.embedding),
                    file: file,
                });
            }
        }
    }

    return scoredEntries;
}