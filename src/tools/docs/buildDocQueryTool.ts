import { tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { docFileRegistry } from "../shared/fileRegistry";
import { adaptFromTool } from "../../utils/shared/pluginCtl";
import { configSchematics } from "../../config"
import { runDocSubAgent } from "./docSubAgent";
import { DOC_QUERY_TOOL_DESCRIPTION } from "../../prompts/docs";

// Sub Agent Tool for documents
export function buildDocQueryTool(ctl: ToolsProviderController) {
    return tool({
        name: "query_document_data",
        description: DOC_QUERY_TOOL_DESCRIPTION,
        parameters: {
            question: z.string(),
            fileName: z.string(),
        },
        implementation: async ({ question, fileName }, toolCtx) => {
            const file = docFileRegistry.lookup(ctl.getWorkingDirectory(), fileName);
            if (!file) {
                return `Error: no file named "${fileName}" is registered for this conversation.`;
            }
 
            const adapted = adaptFromTool(ctl, toolCtx, configSchematics);
 
            const { trace, answer } = await runDocSubAgent(adapted, { question, file });

            // Visible to the user only, per SDK docs — status is not fed to the main model
            // unless echoed in the return value.
            if (typeof toolCtx?.status === "function") {
                toolCtx.status(trace);
            }

            return answer;
        },
    });
}