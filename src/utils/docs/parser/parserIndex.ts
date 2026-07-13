import { ParserChain } from "./parserChain";
import { lmStudioParser } from "./lmstudioParser";
import { ocrPdfParser } from "./ocrPdfParser";
import { pptxTextParser } from "./pptxParser";


import type { Parser, ParseContext } from "./parserTypes";
import type { FileHandle } from "@lmstudio/sdk";

/**
 * Wraps a fallback/catch-all parser so it defers to any "dedicated" parser
 * that claims the file. This lets dedicated parsers stay the single source
 * of truth for which file types they own — no manual extension list to
 * keep in sync elsewhere.
 */
function asFallback(base: Parser, dedicatedParsers: Parser[]): Parser {
  return {
    ...base,
    canParse: async (file: FileHandle, ctx: ParseContext) => {
      for (const dedicated of dedicatedParsers) {
        if (await dedicated.canParse(file, ctx)) {
          return false; // a dedicated parser owns this file type — defer to it
        }
      }
      return base.canParse(file, ctx);
    },
  };
}

export function createDefaultChain(): ParserChain {
  const dedicatedParsers: Parser[] = [pptxTextParser];
  const lmStudioFallback = asFallback(lmStudioParser, dedicatedParsers);

  const chain = new ParserChain()
    .register(lmStudioFallback)
    .register(ocrPdfParser);

  for (const parser of dedicatedParsers) {
    chain.register(parser);
  }

  return chain;
}


export * from "./parserTypes";
export { ParserChain } from "./parserChain";