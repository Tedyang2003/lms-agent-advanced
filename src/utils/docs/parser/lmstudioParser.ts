import type { Parser } from "./parserTypes";

export const lmStudioParser: Parser = {
  name: "lmstudio",
  canParse: () => true, // catch-all default — exclusions handled by asFallback() at registration time
  async parse(file, ctx) {
    const { content } = await ctx.ctl.client.files.parseDocument(file, {
      signal: ctx.ctl.abortSignal,
    });
    const cleaned = content.trim();
    if (cleaned.length === 0) {
      return { success: false, reason: "lmstudio-empty" };
    }
    return { success: true, content, parserName: "lmstudio", isCustomExtraction: false };
  },
};