import { ParserChain } from "./parserChain";
import { lmStudioParser } from "./lmstudioParser";
import { ocrPdfParser } from "./ocrPdfParser";
import { pptxTextParser } from "./pptxParser";

// Registration order is priority order: ParserChain tries every applicable
// parser (each one gated by its own canParse/shouldSkip), then returns the
// best success seen — later parsers only run at all when the earlier one's
// shouldSkip decides the prior result wasn't good enough to skip them. So
// this chain reads as:
//
// - pptxTextParser first: its lossless <a:t> XML-run extraction is strictly
//   better than lmStudio's generic parser for .pptx (which leaves messy,
//   uncleaned XML in its output). On failure, it falls through to lmStudio
//   as a genuine last resort rather than returning empty content.
// - lmStudioParser: the generic catch-all (canParse always true) for
//   everything not already handled above, and pptx's fallback on failure —
//   its own shouldSkip refuses to re-run over a dedicated parser's success.
// - ocrPdfParser last: only attempts .pdf, and only actually runs (via
//   shouldSkip) when lmStudioParser's result on that same file came up too
//   short — OCR is expensive, so it's a quality-gated backfill, not a
//   first attempt.
export function createDefaultChain(): ParserChain {
  return new ParserChain()
    .register(pptxTextParser)
    .register(lmStudioParser)
    .register(ocrPdfParser);
}

export * from "./parserTypes";
export { ParserChain } from "./parserChain";
