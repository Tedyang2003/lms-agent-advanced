import type { FileHandle, LLM, Tool, ChatMessageInput, PredictionResult } from "@lmstudio/sdk";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { buildDocSubAgentTools } from "./docSubAgentTools";
import { buildClarifyingQuestionTool } from "../shared/clarifyingQuestionTool";
import { buildDocSubAgentSystemPrompt, DOC_SUBAGENT_RETRY_LOG_MESSAGE, DOC_SUBAGENT_RETRY_USER_MESSAGE } from "../../prompts/docs";
import { CLARIFICATION_PREFIX } from "../../prompts/shared";

// Same error-sniffing convention as structuredDataSubAgent.ts — lets the retry loop
// tell "called the tool" apart from "called the tool, got an error back, and
// reported that as the answer".
const TOOL_ERROR_PREFIX = /^(error:|sql error:)/i;

async function runOnce(model: LLM, history: ChatMessageInput[], tools: Tool[], ctl: PluginCapableCtl, log: string[]) {
    let finalAnswer = "";
    let sawToolCall = false;
    // Reflects only the MOST RECENT tool result, not "an error happened at any
    // point" — a sticky flag would force a full, expensive retry even after the
    // model self-corrected within this same run, discarding an already-good
    // answer for no reason.
    let lastToolResultWasError = false;
    let lastToolResult = "";

    await model.act(history, tools, {
        signal: ctl.abortSignal,
        contextOverflowPolicy: "truncateMiddle",
        // Bounds a single act() call so a confused small model can't loop
        // indefinitely between tool calls without ever producing an answer.
        maxPredictionRounds: 5,
        // Small/quantized models more often emit tool calls that don't parse
        // (bad JSON, wrong arg shape). Default SDK behavior throws when the
        // request can't be parsed at all, which would abort the whole sub-agent
        // instead of giving the model a chance to self-correct in-loop.
        handleInvalidToolRequest: (error, request) => {
            if (request) return `Invalid tool call: ${error.message}. Retry with corrected arguments.`;
            return "Your tool call could not be parsed. Call the tool again using the exact tool name and valid JSON arguments.";
        },
        onMessage: (message: any) => {
            const data = message?.data;
            if (!data) return;
            const blocks: any[] = Array.isArray(data.content) ? data.content : [];
            for (const block of blocks) {
                if (block.type === "toolCallResult") {
                    sawToolCall = true;
                    const content = String(block.content ?? "");
                    lastToolResultWasError = TOOL_ERROR_PREFIX.test(content.trim());
                    if (!lastToolResultWasError) lastToolResult = content;
                    log.push(`Step: got result — ${content.slice(0, 120)}`);
                } else if (block.type === "toolCallRequest") {
                    sawToolCall = true;
                    const req = block.toolCallRequest ?? {};
                    const name = req.name ?? "unknown_tool";
                    const argsPreview = JSON.stringify(req.arguments ?? {}).slice(0, 120);
                    log.push(`Step: calling ${name}(${argsPreview})`);
                }
            }
            ctl.debug("Document Sub Agent Processed the following", log);
        },
        onPredictionCompleted: (result: PredictionResult) => {
            if (result.content.trim().length > 0) {
                finalAnswer = result.content
                    .replace(/<\|channel>thought[\s\S]*?<channel\|>\n?/g, "")
                    .replace(/<think>[\s\S]*?<\/think>\n?/g, "")
                    .trim();
            }
        },
    });

    return { finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult };
}

export async function runDocSubAgent(
    ctl: PluginCapableCtl,
    args: { question: string; file: FileHandle },
): Promise<{ trace: string; answer: string }> {
    const { question, file } = args;

    const dataTools = buildDocSubAgentTools(ctl, file);
    const clarification = buildClarifyingQuestionTool();
    const tools = [...dataTools, clarification.tool];
    const model = await ctl.client.llm.model();
    const log: string[] = [];

    const systemPrompt = buildDocSubAgentSystemPrompt(file.name);

    let history: ChatMessageInput[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
    ];

    let { finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult } = await runOnce(model, history, tools, ctl, log);
    let bestToolResult = lastToolResult;

    if (clarification.getQuestion()) {
        return {
            trace: log.join("\n"),
            answer: `${CLARIFICATION_PREFIX} ${clarification.getQuestion()}`,
        };
    }

    // Retry once, more forcefully, if the model never actually called a tool,
    // it called one but is about to report the error it got back as the answer,
    // or it called a tool successfully but never produced any final text at all.
    if (!sawToolCall || lastToolResultWasError || !finalAnswer.trim()) {
        log.push(DOC_SUBAGENT_RETRY_LOG_MESSAGE);
        history = [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
            { role: "assistant", content: finalAnswer },
            {
                role: "user",
                content: DOC_SUBAGENT_RETRY_USER_MESSAGE,
            },
        ];
        ({ finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult } = await runOnce(model, history, tools, ctl, log));
        if (lastToolResult) bestToolResult = lastToolResult;

        if (clarification.getQuestion()) {
            return {
                trace: log.join("\n"),
                answer: `${CLARIFICATION_PREFIX} ${clarification.getQuestion()}`,
            };
        }
    }

    if (!sawToolCall) {
        return {
            trace: log.join("\n"),
            answer: `The sub-agent was unable to read "${file.name}" after two attempts. Please try rephrasing the question.`,
        };
    }

    if (finalAnswer.trim()) {
        return { trace: log.join("\n"), answer: finalAnswer };
    }

    // The model never phrased a written answer, but a tool call did succeed at
    // some point — surface that raw result instead of a dead-end generic message,
    // so the retrieved content isn't silently thrown away.
    if (bestToolResult) {
        return {
            trace: log.join("\n"),
            answer:
                `The sub-agent read "${file.name}" successfully but did not phrase a written answer. ` +
                `Raw result:\n${bestToolResult}`,
        };
    }

    return {
        trace: log.join("\n"),
        answer: `No result was returned from querying "${file.name}".`,
    };
}