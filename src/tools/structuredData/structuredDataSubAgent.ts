import type { FileHandle } from "@lmstudio/sdk";
import { buildStructuredDataTools } from "./structuredDataAgentTools";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { runToolSubAgent } from "../shared/runToolSubAgent";
import {
    buildStructuredDataSubAgentSystemPrompt,
    STRUCTURED_DATA_SUBAGENT_RETRY_LOG_MESSAGE,
    STRUCTURED_DATA_SUBAGENT_RETRY_USER_MESSAGE,
    STRUCTURED_DATA_SUBAGENT_RETRY_USER_MESSAGE_MALFORMED_TOOL_CALL,
} from "../../prompts/structuredData";

export async function runStructuredDataSubAgent(
    ctl: PluginCapableCtl,
    args: { question: string; targetFiles: FileHandle[]; schemaSummary: string },
): Promise<{ trace: string; answer: string }> {
    const { question, targetFiles, schemaSummary } = args;

    return runToolSubAgent({
        ctl,
        question,
        systemPrompt: buildStructuredDataSubAgentSystemPrompt(schemaSummary),
        tools: await buildStructuredDataTools(targetFiles, ctl),
        debugLabel: "Structured Data Sub Agent Processed the following",
        retryLogMessage: STRUCTURED_DATA_SUBAGENT_RETRY_LOG_MESSAGE,
        retryUserMessage: STRUCTURED_DATA_SUBAGENT_RETRY_USER_MESSAGE,
        retryUserMessageMalformedToolCall: STRUCTURED_DATA_SUBAGENT_RETRY_USER_MESSAGE_MALFORMED_TOOL_CALL,
        noToolCallMessage: `The sub-agent was unable to query the data after two attempts. Please try rephrasing the question.`,
        rawResultPrefix: `The sub-agent queried the data successfully but did not phrase a written answer. Raw query result:\n`,
        noResultMessage: "No result was returned from the query.",
    });
}
