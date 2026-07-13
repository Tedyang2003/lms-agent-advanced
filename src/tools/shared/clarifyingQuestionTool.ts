import { tool } from "@lmstudio/sdk";
import { z } from "zod";
import { CLARIFYING_QUESTION_DESCRIPTION, CLARIFICATION_RECORDED_MESSAGE } from "../../prompts/shared";

/**
 * Builds a per-invocation "ask_clarifying_question" tool plus a getter for
 * whatever question was recorded. Replaces the old convention of asking the
 * model to reply with a literal "NEEDS_CLARIFICATION: ..." text prefix —
 * small/quantized models are prone to wrapping that in extra words or
 * formatting, silently breaking a string-prefix check. A real tool call is
 * validated by the SDK instead of string-matched by us.
 */
export function buildClarifyingQuestionTool() {
    let question: string | null = null;

    const clarifyTool = tool({
        name: "ask_clarifying_question",
        description: CLARIFYING_QUESTION_DESCRIPTION,
        parameters: {
            question: z.string().describe("A short, specific question about what criteria or interpretation to use."),
        },
        implementation: async ({ question: q }: { question: string }) => {
            question = q;
            return CLARIFICATION_RECORDED_MESSAGE;
        },
    });

    return {
        tool: clarifyTool,
        getQuestion: () => question,
    };
}
