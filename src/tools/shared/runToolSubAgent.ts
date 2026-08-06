import type { LLM, Tool, ChatMessageInput, PredictionResult } from "@lmstudio/sdk";
import { type PluginCapableCtl } from "../../utils/shared/pluginCtl";
import { buildClarifyingQuestionTool } from "./clarifyingQuestionTool";
import { CLARIFICATION_PREFIX } from "../../prompts/shared";

// Matches the error-response prefixes the various sub-agent tools (query_table,
// search_document_chunks, ...) return — lets the retry loop tell "called the tool"
// apart from "called the tool, got an error back, and reported that as the answer".
const TOOL_ERROR_PREFIX = /^(error:|sql error:)/i;

// Bounds a single act() call so a confused small model can't loop indefinitely
// between tool calls without ever producing an answer.
const MAX_PREDICTION_ROUNDS = 6;

interface RunToolSubAgentParams {
    ctl: PluginCapableCtl;
    question: string;
    systemPrompt: string;
    tools: Tool[];
    debugLabel: string;
    retryLogMessage: string;
    retryUserMessage: string;
    retryUserMessageMalformedToolCall: string;
    noToolCallMessage: string;
    rawResultPrefix: string;
    noResultMessage: string;
}

async function runOnce(model: LLM, history: ChatMessageInput[], tools: Tool[], ctl: PluginCapableCtl, log: string[], debugLabel: string) {
    let finalAnswer = "";
    let sawToolCall = false;
    // Reflects only the MOST RECENT tool result, not "an error happened at any
    // point" — a sticky flag would force a full, expensive retry even after the
    // model self-corrected within this same run, discarding an already-good
    // answer for no reason.
    let lastToolResultWasError = false;
    let lastToolResult = "";
    // Set when a tool call fails to parse entirely (not just invalid args). The SDK
    // ignores whatever handleInvalidToolRequest returns in that case (verified from its
    // own type docs — there is no in-loop way to feed the model a correction), so this
    // flag is how the OUTER retry loop finds out it happened, to force a fresh retry
    // with a message describing the actual failure instead of a generic one.
    let hadUnparseableToolCall = false;

    await model.act(history, tools, {
        signal: ctl.abortSignal,
        contextOverflowPolicy: "truncateMiddle",
        maxPredictionRounds: MAX_PREDICTION_ROUNDS,
        // Small/quantized models more often emit tool calls that don't parse
        // (bad JSON, wrong arg shape). Default SDK behavior throws when the
        // request can't be parsed at all, which would abort the whole sub-agent
        // instead of giving the model a chance to self-correct via the outer retry.
        handleInvalidToolRequest: (error, request) => {
            // request is only defined when the call partially parsed but was invalid
            // (wrong args, unknown tool) — that case can be given a retry message. When
            // request is undefined, the call failed to parse at all; the SDK ignores any
            // return value here, so hadUnparseableToolCall is the only way this reaches
            // the retry logic below.
            if (request) return `Invalid tool call: ${error.message}. Retry with corrected arguments.`;
            hadUnparseableToolCall = true;
            return undefined;
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
            ctl.debug(debugLabel, log);
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

    return { finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult, hadUnparseableToolCall };
}

export async function runToolSubAgent(params: RunToolSubAgentParams): Promise<{ trace: string; answer: string }> {
    const {
        ctl,
        question,
        systemPrompt,
        tools: dataTools,
        debugLabel,
        retryLogMessage,
        retryUserMessage,
        retryUserMessageMalformedToolCall,
        noToolCallMessage,
        rawResultPrefix,
        noResultMessage,
    } = params;

    const clarification = buildClarifyingQuestionTool();
    const tools = [...dataTools, clarification.tool];
    const model = await ctl.client.llm.model();
    const log: string[] = [];

    let history: ChatMessageInput[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
    ];

    let { finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult, hadUnparseableToolCall } = await runOnce(model, history, tools, ctl, log, debugLabel);
    let bestToolResult = lastToolResult;

    if (clarification.getQuestion()) {
        return {
            trace: log.join("\n"),
            answer: `${CLARIFICATION_PREFIX} ${clarification.getQuestion()}`,
        };
    }

    // Retry once, more forcefully, if the model never actually called a tool, it
    // called one but is about to report the error it got back as the answer, it
    // called a tool successfully but never produced any final text at all, or its
    // tool call was too malformed to even parse (hadUnparseableToolCall — the only
    // way that case reaches here, since the SDK gives no in-loop feedback for it).
    if (!sawToolCall || lastToolResultWasError || !finalAnswer.trim() || hadUnparseableToolCall) {
        log.push(retryLogMessage);
        history = [
            { role: "system", content: systemPrompt },
            { role: "user", content: question },
            { role: "assistant", content: finalAnswer },
            {
                role: "user",
                content: hadUnparseableToolCall ? retryUserMessageMalformedToolCall : retryUserMessage,
            },
        ];
        ({ finalAnswer, sawToolCall, lastToolResultWasError, lastToolResult, hadUnparseableToolCall } = await runOnce(model, history, tools, ctl, log, debugLabel));
        if (lastToolResult) bestToolResult = lastToolResult;

        if (clarification.getQuestion()) {
            return {
                trace: log.join("\n"),
                answer: `${CLARIFICATION_PREFIX} ${clarification.getQuestion()}`,
            };
        }
    }

    if (!sawToolCall) {
        return { trace: log.join("\n"), answer: noToolCallMessage };
    }

    if (finalAnswer.trim()) {
        return { trace: log.join("\n"), answer: finalAnswer };
    }

    // The model never phrased a written answer, but a tool call did succeed at
    // some point — surface that raw result instead of a dead-end generic message,
    // so the retrieved content isn't silently thrown away.
    if (bestToolResult) {
        return { trace: log.join("\n"), answer: `${rawResultPrefix}${bestToolResult}` };
    }

    return { trace: log.join("\n"), answer: noResultMessage };
}
