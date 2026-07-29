import type { Parser } from "./parserTypes";

export const lmStudioParser: Parser = {
  name: "lmstudio",
  canParse: () => true, // catch-all default — relies on chain registration order (parserIndex.ts) for priority
  // Never re-attempt a file a dedicated parser already succeeded on (e.g. pptx) — dedicated
  // parsers run before this one in the chain, so any prior success is by definition preferred.
  shouldSkip: (previous) => previous?.success === true,
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