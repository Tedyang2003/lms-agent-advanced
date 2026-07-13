import {
    type ChatMessage,
    type PromptPreprocessorController,
} from "@lmstudio/sdk";
import { excelFileRegistry, docFileRegistry } from "./tools/shared/fileRegistry";
import { adaptFromPreprocessor } from "./utils/shared/pluginCtl";
import { configSchematics } from "./config";
import { makeDocPreview } from "./utils/docs/retrieval/filePreview";
import { makeExcelPreview } from "./utils/excel/excelPreview";
import { buildDocsAttachedTag, buildExcelAttachedTag, buildAvailableFilesReminder } from "./prompts/promptPreprocessor";

const EXCEL_EXTENSIONS = [".xlsx", ".xls", ".xlsm"];
const isExcelFile = (f: { name: string }) =>
    EXCEL_EXTENSIONS.some(ext => f.name.toLowerCase().endsWith(ext));

export async function preprocess(ctl: PromptPreprocessorController, userMessage: ChatMessage) {
    const originalUserText = userMessage.getText();
    const workingDir = ctl.getWorkingDirectory();

    const newFiles = userMessage.getFiles(ctl.client).filter(f => f.type !== "image");
    const newExcelFiles = newFiles.filter(isExcelFile);
    const newDocFiles = newFiles.filter(f => !isExcelFile(f));

    // getWorkingDirectory() is scoped to "the current prediction," not the conversation —
    // LM Studio can hand out a fresh one on a turn that processes a new attachment. Tools
    // (query_excel_data etc.) only ever see this same turn's workingDir, so we re-sync the
    // registry for THIS key from the real chat history on every turn, rather than trusting
    // whatever was registered under a possibly-stale previous key.
    const history = await ctl.pullHistory();
    const historyFiles = history.getAllFiles(ctl.client).filter(f => f.type !== "image");
    const historyExcelFiles = historyFiles.filter(isExcelFile);
    const historyDocFiles = historyFiles.filter(f => !isExcelFile(f));

    for (const f of [...historyExcelFiles, ...newExcelFiles]) excelFileRegistry.register(workingDir, f);
    for (const f of [...historyDocFiles, ...newDocFiles]) docFileRegistry.register(workingDir, f);

    const allExcelFiles = excelFileRegistry.getAll(workingDir);
    const allDocFiles = docFileRegistry.getAll(workingDir);

    if (allExcelFiles.length === 0 && allDocFiles.length === 0) return userMessage;

    const adapted = adaptFromPreprocessor(ctl, configSchematics);

    const tags: string[] = [];

    // Full preview + "use this tool" guidance ONLY for files newly attached this turn.
    // Repeating the full announcement on every subsequent turn regardless of relevance
    // is what previously made the main model fixate on "check the docs" even for
    // unrelated questions, then wrongly report "no info" when a search on those came
    // up empty.
    if (newDocFiles.length > 0) {
        const docLines = await Promise.all(
            newDocFiles.map(async f => `- ${f.name}: ${await makeDocPreview(f, adapted)}`)
        );
        tags.push(buildDocsAttachedTag(docLines));
    }

    if (newExcelFiles.length > 0) {
        const excelLines = await Promise.all(
            newExcelFiles.map(async f => `- ${f.name}: ${await makeExcelPreview(f)}`)
        );
        tags.push(buildExcelAttachedTag(excelLines));
    }

    // A short, low-key reminder on EVERY turn (not just when new files arrive) — this is
    // what keeps the file lifecycle alive for the rest of the conversation, so the model
    // can still reach an old file many turns later without needing to remember the full
    // preview from when it was attached. It's deliberately terse and says to ignore it
    // when irrelevant, so it doesn't reintroduce the fixation problem the full-preview
    // version caused when repeated every turn.
    const allNames = [...allExcelFiles, ...allDocFiles].map(f => f.name);
    tags.push(buildAvailableFilesReminder(allNames));

    userMessage.replaceText(tags.join("\n\n") + `\n\n${originalUserText}`);
    return userMessage;
}