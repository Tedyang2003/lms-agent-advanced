import type { FileHandle } from "@lmstudio/sdk";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { buildDocSubAgentTools } from "./docSubAgentTools";
import { runToolSubAgent } from "../shared/runToolSubAgent";
import {
    buildDocSubAgentSystemPrompt,
    DOC_SUBAGENT_RETRY_LOG_MESSAGE,
    DOC_SUBAGENT_RETRY_USER_MESSAGE,
    DOC_SUBAGENT_RETRY_USER_MESSAGE_MALFORMED_TOOL_CALL,
} from "../../prompts/docs";

export async function runDocSubAgent(
    ctl: PluginCapableCtl,
    args: { question: string; file: FileHandle },
): Promise<{ trace: string; answer: string }> {
    const { question, file } = args;

    return runToolSubAgent({
        ctl,
        question,
        systemPrompt: buildDocSubAgentSystemPrompt(file.name),
        tools: buildDocSubAgentTools(ctl, file),
        debugLabel: "Document Sub Agent Processed the following",
        retryLogMessage: DOC_SUBAGENT_RETRY_LOG_MESSAGE,
        retryUserMessage: DOC_SUBAGENT_RETRY_USER_MESSAGE,
        retryUserMessageMalformedToolCall: DOC_SUBAGENT_RETRY_USER_MESSAGE_MALFORMED_TOOL_CALL,
        noToolCallMessage: `The sub-agent was unable to read "${file.name}" after two attempts. Please try rephrasing the question.`,
        rawResultPrefix: `The sub-agent read "${file.name}" successfully but did not phrase a written answer. Raw result:\n`,
        noResultMessage: `No result was returned from querying "${file.name}".`,
    });
}
