import { tool, type ToolsProviderController } from "@lmstudio/sdk";
import { excelFileRegistry, docFileRegistry } from "./fileRegistry";
import { makeExcelPreview } from "../../utils/excel/excelPreview";
import { makeDocPreview } from "../../utils/docs/retrieval/filePreview";
import { adaptFromTool } from "../../utils/shared/pluginCtl";
import { configSchematics } from "../../config";
import { LIST_ATTACHED_FILES_DESCRIPTION } from "../../prompts/shared";

/**
 * The preprocessor only injects the file list/preview once, into the message
 * that triggered registration. On a long chat with a small context window,
 * that turn can scroll out of the model's view — this tool lets the model
 * re-discover what's attached on demand instead of guessing a fileName from
 * memory or giving up.
 */
export function buildListAttachedFilesTool(ctl: ToolsProviderController) {
    return tool({
        name: "list_attached_files",
        description: LIST_ATTACHED_FILES_DESCRIPTION,
        parameters: {},
        implementation: async (_args, toolCtx) => {
            const workingDir = ctl.getWorkingDirectory();
            const excelFiles = excelFileRegistry.getAll(workingDir);
            const docFiles = docFileRegistry.getAll(workingDir);

            if (excelFiles.length === 0 && docFiles.length === 0) {
                return "No files are currently attached to this conversation.";
            }

            const adapted = adaptFromTool(ctl, toolCtx, configSchematics);
            const lines: string[] = [];

            if (excelFiles.length > 0) {
                const excelLines = await Promise.all(
                    excelFiles.map(async f => `- [spreadsheet] ${f.name}: ${await makeExcelPreview(f)}`),
                );
                lines.push(...excelLines);
            }

            if (docFiles.length > 0) {
                const docLines = await Promise.all(
                    docFiles.map(async f => `- [document] ${f.name}: ${await makeDocPreview(f, adapted)}`),
                );
                lines.push(...docLines);
            }

            return lines.join("\n");
        },
    });
}
