import type { FileHandle } from "@lmstudio/sdk";
import type { Parser, ParseContext, ParseResult } from "./parserTypes";

export class ParserChain {
  private parsers: Parser[] = [];

  register(parser: Parser): this {
    this.parsers.push(parser);
    return this;
  }

  async run(file: FileHandle, ctx: ParseContext): Promise<ParseResult> {
    let lastResult: ParseResult | undefined;

    for (const parser of this.parsers) {
      const applicable = await parser.canParse(file, ctx);
      if (!applicable) continue;

      if (parser.shouldSkip?.(lastResult, file, ctx)) continue;

      ctx.ctl.debug(`[ParserChain] Trying '${parser.name}' for ${file.name}`);
      const result = await parser.parse(file, ctx);
      lastResult = result;

      if (result.success) {
        return result;
      }
      ctx.ctl.debug(`[ParserChain] '${parser.name}' failed for ${file.name}: ${result.reason}`);
    }

    return lastResult ?? { success: false, reason: "no-parser-matched" };
  }
}