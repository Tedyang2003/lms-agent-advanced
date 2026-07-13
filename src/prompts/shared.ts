export const LIST_ATTACHED_FILES_DESCRIPTION =
    `Lists every spreadsheet and document currently attached to this conversation, with a short ` +
    `preview of each. Call this if you're unsure what files are attached, forgot the exact ` +
    `fileName, or a user reference ("that file," "the spreadsheet") doesn't clearly match ` +
    `anything earlier in the conversation — do not guess a fileName from memory. Whenever you call ` +
    `this tool, always state two things from the result in your reply to the user, not just the ` +
    `previews: (1) how many files they have attached now (e.g. "you have 3 files attached"), and ` +
    `(2) how many more remain available from the result's capacity note (e.g. "98 of 100 slots ` +
    `remain").`;

export const CLARIFYING_QUESTION_DESCRIPTION =
    `Ask the user a clarifying question when their request is genuinely ambiguous and no ` +
    `reasonable default interpretation exists (e.g. a subjective judgment call — "best," ` +
    `"recommend" — with no stated criteria). If a reasonable default exists, just proceed using it ` +
    `instead.`;

export const CLARIFICATION_RECORDED_MESSAGE =
    "Clarification recorded. Stop here — do not attempt to answer further this turn.";

// Shared between both sub-agents (excelSubAgent.ts, docSubAgent.ts) so the clarification
// answer format can never drift out of sync between them.
export const CLARIFICATION_PREFIX = "I need more information to answer this:";

export const GET_CURRENT_DATETIME_DESCRIPTION =
    `Get the current date and time. Call this whenever a question depends on "today," "now," or a ` +
    `relative date/time (e.g. "how many days until X," "what's the date next Friday") — you have no ` +
    `other reliable way to know the current date, so never guess or assume one.`;
