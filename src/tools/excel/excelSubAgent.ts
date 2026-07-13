
import type { FileHandle, LLM, Tool, ChatMessageInput, PredictionResult } from "@lmstudio/sdk";
import { buildExcelTools } from "./buildExcelTools";
import { buildClarifyingQuestionTool } from "../shared/clarifyingQuestionTool";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { buildExcelSubAgentSystemPrompt, EXCEL_SUBAGENT_RETRY_LOG_MESSAGE, EXCEL_SUBAGENT_RETRY_USER_MESSAGE } from "../../prompts/excel";
import { CLARIFICATION_PREFIX } from "../../prompts/shared";

// Matches the error-response prefixes query_spreadsheet actually returns
// (buildExcelTools.ts) — lets the retry loop tell "called the tool" apart
// from "called the tool, got an error back, and reported that as the answer".
const TOOL_ERROR_PREFIX = /^(error:|sql error:)/i;

async function runOnce(model: LLM, history: ChatMessageInput[], tools: Tool[], ctl: PluginCapableCtl, log: string[]) {
    let finalAnswer = "";
    let sawToolCall = false;
    // Reflects only the MOST RECENT tool result, not "an error happened at any
    // point" — a sticky flag would force a full, expensive retry even after the
    // model self-corrected (error → retry with fixed SQL → success) within this
    // same run, discarding an already-good answer for no reason.
    let lastToolResultWasError = false;
    let lastToolResult = "";

    await model.act(history, tools, {
        signal: ctl.abortSignal,
        contextOverflowPolicy: "truncateMiddle",
        // Bounds a single act() call so a confused small model can't loop
        // indefinitely between tool calls without ever producing an answer.
        maxPredictionRounds: 6,
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
                } else if (block.type === "toolCallRequest" || block.type === "toolCall") {
                    sawToolCall = true;

                    const req = block.toolCallRequest ?? {};
                    const name = req.name ?? "unknown_tool";
                    const argsPreview = JSON.stringify(req.arguments ?? {}).slice(0, 120);
                    log.push(`Step: calling ${name}(${argsPreview})`);
                }
            }
            ctl.debug("Excel Sub Agent Processed the following", log);
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

export async function runExcelSubAgent(
    ctl: PluginCapableCtl,
    args: { question: string; targetFiles: FileHandle[]; schemaSummary: string },
): Promise<{ trace: string; answer: string }> {
    const { question, targetFiles, schemaSummary } = args;

    const dataTools = await buildExcelTools(targetFiles, ctl);
    const clarification = buildClarifyingQuestionTool();
    const tools = [...dataTools, clarification.tool];
    const model = await ctl.client.llm.model();
    const log: string[] = [];

    const systemPrompt = buildExcelSubAgentSystemPrompt(schemaSummary);

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

    // One forceful retry (not three) if the model never actually called the tool,
    // it called it but is about to report the error it got back as if it were the
    // answer, or it called the tool successfully but never produced final text.
    // The single retry message covers both correction paths (call the tool /
    // ask for clarification) so a small model gets the full instruction on its
    // one extra chance, instead of needing a second retry to learn about the
    // clarification option.
    if (!sawToolCall || lastToolResultWasError || !finalAnswer.trim()) {
        log.push(EXCEL_SUBAGENT_RETRY_LOG_MESSAGE);
        history = [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
            { role: "assistant", content: finalAnswer },
            {
                role: "user",
                content: EXCEL_SUBAGENT_RETRY_USER_MESSAGE,
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

    if (finalAnswer.trim()) {
        return { trace: log.join("\n"), answer: finalAnswer };
    }

    // The model never phrased a written answer across all attempts, but a query
    // did succeed at some point — surface that raw result instead of a dead-end
    // generic message, so the retrieved data isn't silently thrown away.
    if (bestToolResult) {
        return {
            trace: log.join("\n"),
            answer:
                `The sub-agent queried the spreadsheet successfully but did not phrase a written answer. ` +
                `Raw query result:\n${bestToolResult}`,
        };
    }

    return {
        trace: log.join("\n"),
        answer: "No result was returned from the spreadsheet query.",
    };
}
