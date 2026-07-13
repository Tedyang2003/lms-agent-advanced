export function buildDocsAttachedTag(docLines: string[]): string {
    return (
        `Document(s) just attached (previews below — do NOT guess a file's topic from its filename alone, ` +
        `use these previews instead):\n${docLines.join("\n")}\n` +
        `Use query_document_data with the exact fileName if a question turns out to be about this file.`
    );
}

export function buildExcelAttachedTag(excelLines: string[]): string {
    return (
        `Spreadsheet(s) just attached (previews below):\n${excelLines.join("\n")}\n` +
        `Use query_excel_data with the exact fileName if a question turns out to be about this file.`
    );
}

export function buildAvailableFilesReminder(allNames: string[]): string {
    return (
        `(Available if relevant: ${allNames.join(", ")} — look up with query_excel_data/` +
        `query_document_data by exact fileName, or call list_attached_files for previews. If the ` +
        `question below has nothing to do with these files — a general-knowledge question, a broad ` +
        `open-ended request, you MUST answer it as well based on your own knowledge.)`
    );
}
