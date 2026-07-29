import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import type { FileHandle } from "@lmstudio/sdk";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { parseFile } from "../../utils/docs/parser/parseFile";
import { embedCustomParsedFiles } from "../../utils/docs/retrieval/embedCustomParsedFiles";
import { buildSearchDocumentChunksDescription, buildGetFullDocumentTextDescription } from "../../prompts/docs";
import { DOC_FULL_TEXT_CHAR_CAP } from "../../constants";

/**
 * Builds the two tools the doc sub-agent chooses between:
 * - search_document_chunks: semantic search, best for specific facts/quotes
 * - get_full_document_text: full (possibly truncated) text, best for
 *   summarization / overview questions that don't match any single passage
 */
export function buildDocSubAgentTools(ctl: PluginCapableCtl, file: FileHandle) {
    const searchTool = tool({
        name: "search_document_chunks",
        description: buildSearchDocumentChunksDescription(file.name),
        parameters: {
            query: z.string().describe("A specific, targeted search query — not a vague request like 'summarize'."),
        },
        implementation: async ({ query }: { query: string }) => {
            const model = await ctl.client.embedding.model(ctl.getConfigValue("embeddingModel"), {
                signal: ctl.abortSignal,
            });

            const retrievalLimit = ctl.getConfigValue("retrievalLimit");
            const retrievalAffinityThreshold = ctl.getConfigValue("retrievalAffinityThreshold");

            // Always route through our own chunk-embedding pipeline (cosine similarity)
            // rather than the SDK's native file retrieval, so every file — regardless of
            // which parser produced its text — is scored on the same scale. Mixing the
            // SDK's own (undocumented) retrieval score with our cosine similarity meant
            // retrievalAffinityThreshold could behave inconsistently across files.
            const parsed = await parseFile(ctl, file);
            const rawEntries = await embedCustomParsedFiles(
                ctl,
                query,
                [{ file, content: parsed.content }],
                model,
            );

            const entries = rawEntries
                .filter((e) => e.score > retrievalAffinityThreshold)
                .sort((a, b) => b.score - a.score)
                .slice(0, retrievalLimit);

            if (entries.length === 0) {
                return (
                    `No passages in "${file.name}" scored above the relevance threshold for this query. ` +
                    `If you need a broad overview instead of a specific fact, call get_full_document_text.`
                );
            }

            return entries
                .map((e: any, i: number) => `[${i + 1}] ${(e.content)}`)
                .join("\n\n");
        },
    });

    const fullTextTool = tool({
        name: "get_full_document_text",
        description: buildGetFullDocumentTextDescription(file.name),
        parameters: {},
        implementation: async () => {
            const parsed = await parseFile(ctl, file);
            const cleaned = parsed.content;
            if (cleaned.length <= DOC_FULL_TEXT_CHAR_CAP) {
                return cleaned;
            }
            return cleaned.slice(0, DOC_FULL_TEXT_CHAR_CAP) + "\n\n(...document truncated, content continues beyond this point...)";
        },
    });

    return [searchTool, fullTextTool];
}