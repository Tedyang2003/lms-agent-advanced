import type { FileHandle } from "@lmstudio/sdk";
import type { Parser, ParseContext, ParseResult } from "./parserTypes";

export class ParserChain {
  private parsers: Parser[] = [];

  register(parser: Parser): this {
    this.parsers.push(parser);
    return this;
  }

  async run(file: FileHandle, ctx: ParseContext): Promise<ParseResult> {
    // lastResult is what shouldSkip inspects — "did the parser immediately
    // before me already produce a good-enough result?" bestSuccess is what
    // we actually return — the most recent SUCCESS seen, so that a later
    // parser's failure (e.g. OCR finding too little text and reporting
    // failure) can't erase an earlier parser's successful-but-thin result.
    let lastResult: ParseResult | undefined;
    let bestSuccess: ParseResult | undefined;

    for (const parser of this.parsers) {
      const applicable = await parser.canParse(file, ctx);
      if (!applicable) continue;

      if (parser.shouldSkip?.(lastResult, file, ctx)) continue;

      ctx.ctl.debug(`[ParserChain] Trying '${parser.name}' for ${file.name}`);
      const result = await parser.parse(file, ctx);
      lastResult = result;

      if (result.success) {
        bestSuccess = result;
      } else {
        ctx.ctl.debug(`[ParserChain] '${parser.name}' failed for ${file.name}: ${result.reason}`);
      }
    }

    return bestSuccess ?? lastResult ?? { success: false, reason: "no-parser-matched" };
  }
}