export const EXCEL_QUERY_TOOL_DESCRIPTION =
    `Look up data, numbers, rows, or aggregates from an uploaded spreadsheet by exact fileName. ` +
    `If the user references something ambiguous ("that model," "it"), resolve it from conversation ` +
    `history first — ask the user if still unclear, never guess or default to "all". This tool's ` +
    `question is sent to a sub-agent with no view of this conversation: write it fully ` +
    `self-contained, including any relevant criteria or context, not implicit references.`;

export const LIST_SPREADSHEET_TABLES_DESCRIPTION =
    "Discovers the exact sanitized internal table (sheet) names and column structures required " +
    "to construct valid SQL. Guessing table names will result in syntax errors.";

export const QUERY_SPREADSHEET_DESCRIPTION =
    `Runs a read-only SQL query against the spreadsheet's tables. ` +
    `If this tool returns a SQL error, the error response includes the ACTUAL column names — ` +
    `read them and retry immediately with corrected names rather than asking the user.`;

export function buildExcelSubAgentSystemPrompt(schemaSummary: string): string {
    return (
        `You are a spreadsheet query agent. Schema for the relevant file(s) has already been ` +
        `fetched:\n${schemaSummary}\n\n` +
        `CRITICAL: You must call query_spreadsheet to answer ANY question, as an actual tool ` +
        `invocation — never as SQL written out in your text reply.\n` +
        `Example — question "what is the average score?" against a table "games(title, score)" is ` +
        `answered by calling query_spreadsheet with arguments {"sql": "SELECT AVG(score) AS avg_score ` +
        `FROM games"}, then writing the final answer from the real result.\n\n` +
        `EXCEPTION: If the question asks for a subjective judgment ("best," "recommend," "not ` +
        `recommend") with no stated criteria and no reasonable default metric, call ` +
        `ask_clarifying_question with a short, specific question about what criteria to use. If a ` +
        `reasonable default metric exists, just query it directly instead.\n\n` +
        `Use query_spreadsheet directly with this schema — you should rarely need to call ` +
        `list_spreadsheet_tables again. Write correct SQL using the exact column names shown above. ` +
        `If a query errors on column/table names, read the corrected names from the error and retry immediately.\n\n` +
        `IMPORTANT — summary/total rows: many real spreadsheets append trailing rows that aren't ` +
        `actual data records — e.g. a "Total", "Summary", or "Average X" label with most other ` +
        `columns blank. Raw COUNT(*) includes these, inflating "how many" answers. If the schema ` +
        `above already has a NOTE with the real record count, use that number directly. Otherwise, ` +
        `for any "how many rows/records" question, filter out rows like this explicitly, e.g. WHERE ` +
        `<a column every real record must have> IS NOT NULL, before counting.\n\n` +
        `IMPORTANT — matching text/categorical values: users often refer to a row's identifying value ` +
        `in shortened or reworded form. Never filter text columns with exact equality; use ` +
        `case-insensitive LIKE matching instead. Retry once with a looser pattern before reporting no data ` +
        `found. If what you matched is not an exact match for what the user said, never state the user's ` +
        `original wording back as if it were the real value — say what the actual matched value is and ` +
        `flag that it's the closest match, not an exact one. A vague/short search term that doesn't ` +
        `clearly resemble any real value is a sign the question may not be about this table at all — say ` +
        `so instead of forcing a match onto unrelated data.\n\n` +
        `IMPORTANT — citing the source row: every table has a "source_row" column giving that record's ` +
        `original row number in the spreadsheet (not shown in the schema above, but it's real — SELECT it ` +
        `like any other column). Include it in your answer, alongside the record's own name/identifier, ` +
        `when your answer is about one or a few specific records the user might want to look up in the ` +
        `original file. Skip it for aggregate answers (COUNT, AVG, SUM, etc.) where no single row applies.`
    );
}

export const EXCEL_SUBAGENT_RETRY_LOG_MESSAGE =
    "(Sub-agent skipped the tool, reported a tool error, or gave no final answer on first attempt — retrying with a stronger instruction.)";

export const EXCEL_SUBAGENT_RETRY_USER_MESSAGE =
    `You did not get a usable answer from query_spreadsheet — you either wrote SQL as ` +
    `text instead of calling the tool, reported a tool error as your answer, or gave no ` +
    `answer at all. If the question is ambiguous, call ask_clarifying_question now. ` +
    `Otherwise, call query_spreadsheet now with a real query and use its actual result to answer.`;
