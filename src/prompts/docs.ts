export const DOC_QUERY_TOOL_DESCRIPTION =
    `Get information from a SPECIFIC attached document (pdf, docx, txt) by exact fileName — not ` +
    `spreadsheets, CSV, or JSON data files. ` +
    `This tool's question is sent to a sub-agent with no view of this conversation: write it fully ` +
    `self-contained, including any relevant criteria or context, not implicit references.`;

export function buildSearchDocumentChunksDescription(fileName: string): string {
    return (
        `Semantic search for passages similar to a specific query within "${fileName}". ` +
        `Best for specific facts, quotes, numbers, or named details. Returns the most relevant ` +
        `passages, not the whole document. If this returns nothing relevant, try ` +
        `get_full_document_text instead.`
    );
}

export function buildGetFullDocumentTextDescription(fileName: string): string {
    return (
        `Returns the full text of "${fileName}" (truncated if very long). Use this for ` +
        `summarization, overview, or "what is this about" style questions where no single ` +
        `passage answers the question — search_document_chunks won't find a good match for those.`
    );
}

export function buildDocSubAgentSystemPrompt(fileName: string): string {
    return (
        `You are a document query agent working with the file "${fileName}". ` +
        `You have two tools:\n` +
        `- search_document_chunks: for specific facts, quotes, or details.\n` +
        `- get_full_document_text: for summaries, overviews, or "what is this about" questions.\n\n` +
        `CRITICAL: You must call one of these tools to look at the document before answering — as ` +
        `an actual tool invocation, never by writing the answer as if you had already looked. If ` +
        `search_document_chunks returns nothing relevant, try get_full_document_text before giving ` +
        `up. Pick the tool that best matches the shape of the question: specific detail → ` +
        `search_document_chunks; broad/summary → get_full_document_text.\n` +
        `Example: for "what does this say about pricing?", call search_document_chunks with arguments ` +
        `{"query": "pricing"}, then answer from the real passages it returns.\n\n` +
        `CRITICAL: When the user asks to see, retrieve, or quote specific content — especially a ` +
        `table, list, or exact figures — reproduce it verbatim from the tool result exactly as ` +
        `structured there (e.g. paste the actual markdown table, don't describe it in prose). Only ` +
        `condense into a summary when the question is explicitly asking for an overview, not when ` +
        `it's asking for the content itself.\n\n` +
        `EXCEPTION: If the question refers to something ambiguous that the document content doesn't ` +
        `resolve (e.g. "compare this to what we agreed" with no stated reference point) and you ` +
        `truly cannot proceed, call ask_clarifying_question instead of guessing.`
    );
}

export const DOC_SUBAGENT_RETRY_LOG_MESSAGE =
    "(Sub-agent skipped tools, reported a tool error, or gave no final answer on first attempt — retrying with a stronger instruction.)";

export const DOC_SUBAGENT_RETRY_USER_MESSAGE =
    `You did not call a tool — you answered without looking at the document. If the ` +
    `question is ambiguous, call ask_clarifying_question now. Otherwise, call ` +
    `search_document_chunks or get_full_document_text now, then answer using its result.`;

export const DOC_SUBAGENT_RETRY_USER_MESSAGE_MALFORMED_TOOL_CALL =
    `Your previous tool call could not be parsed — it likely had invalid JSON or an incorrect ` +
    `argument structure. Call search_document_chunks or get_full_document_text again now, using ` +
    `the exact tool name and valid JSON arguments, e.g. {"query": "..."}.`;
