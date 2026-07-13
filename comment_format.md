# Comment Format

How to comment code in this plugin. Read this before writing or editing comments in `src/`.

## Core rule

Comment the **why**, never the **what**. Code already says what it does — a comment repeating that is noise. Only write a comment when there's a hidden reason someone reading the code cold couldn't otherwise guess: a specific model failure mode, an SDK constraint, a security boundary, a past incident.

Self-check before writing any comment: **if I delete this, would a future reader be confused or make a worse decision?** If no, delete it.

## Placement and style

**Block comment (`/** ... */`) directly above an exported function** — when the function's existence or shape needs justifying, not just its mechanics. Used when the "why does this abstraction exist at all" question isn't answerable from the signature alone.

```ts
/**
 * Builds a per-invocation "ask_clarifying_question" tool plus a getter for
 * whatever question was recorded. Replaces the old convention of asking the
 * model to reply with a literal "NEEDS_CLARIFICATION: ..." text prefix —
 * small/quantized models are prone to wrapping that in extra words or
 * formatting, silently breaking a string-prefix check. A real tool call is
 * validated by the SDK instead of string-matched by us.
 */
export function buildClarifyingQuestionTool() { ... }
```

**Inline `//` comment immediately above the specific line/option it justifies** — never a few lines above, never trailing at the end of a long line. If a comment explains one field in an options object, it sits directly above that field, not above the whole call.

```ts
await model.act(history, tools, {
    signal: ctl.abortSignal,
    contextOverflowPolicy: "truncateMiddle",
    // Bounds a single act() call so a confused small model can't loop
    // indefinitely between tool calls without ever producing an answer.
    maxPredictionRounds: 6,
```

**One-line comment above a regex/constant** when the pattern encodes a specific contract with other code, not just "what it matches."

```ts
// Matches the error-response prefixes query_spreadsheet actually returns
// (buildExcelTools.ts) — lets the retry loop tell "called the tool" apart
// from "called the tool, got an error back, and reported that as the answer".
const TOOL_ERROR_PREFIX = /^(error:|sql error:)/i;
```

## What earns a comment in this codebase

- **A specific small/quantized-model failure mode being worked around.** Name the failure, not just "handle edge case." Compare "handles bad input" (bad) vs. "Small/quantized models more often emit tool calls that don't parse (bad JSON, wrong arg shape)" (good, from `excelSubAgent.ts`).
- **An SDK/runtime constraint that isn't visible from the type signature.** E.g. `getWorkingDirectory()` being scoped to "the current prediction" rather than the conversation — that's a real gotcha the type alone doesn't convey.
- **A security boundary**, stated as what it actually guarantees, not just what the code does:
  ```ts
  // Seal the database before it's ever exposed to LLM-generated SQL. This is the
  // real security boundary for query_spreadsheet: enable_external_access=false
  // makes DuckDB itself refuse ATTACH/COPY/read_csv/read_parquet/etc. regardless
  // of what the SQL text looks like, and lock_configuration=true stops a crafted
  // query from re-enabling it. SQL_DENYLIST below is now defense-in-depth only,
  // not the primary guard.
  ```
- **Why an eviction/cache/retry strategy was chosen**, when the mechanics alone don't explain the tradeoff:
  ```ts
  // Evicts the oldest entry once the cache grows past MAX_CACHE_ENTRIES, closing
  // its DuckDB connection so native handles don't leak.
  ```
- **A past behavioral regression and what specifically caused it**, when that history changes what "correct" looks like going forward:
  ```ts
  // Repeating the full announcement on every subsequent turn regardless of relevance
  // is what previously made the main model fixate on "check the docs" even for
  // unrelated questions, then wrongly report "no info" when a search on those came
  // up empty.
  ```

## What does NOT earn a comment

- Restating a descriptive function/variable name in prose ("// registers the excel file" above `registerExcelFile(...)`).
- Generic parameter/return descriptions (`@param`, `@returns`) — types already carry this; skip JSDoc tags entirely unless a param's valid range or unit isn't expressible in the type.
- Comments describing the current task/PR/issue ("added for the file-registry fix", "// see PR #123") — these rot the moment the surrounding code changes again and belong in a commit message, not the file.
- A comment on every field of a config object — only the fields whose value needs justifying, not the ones that are self-evident from their name (`retrievalLimit: 3` needs no comment; `lock_configuration=true` does).
- Multi-paragraph comment blocks. If the reasoning needs more than ~5 lines, it's a sign the code itself should be simplified or the reasoning belongs in the PR description, not inline.

## Quick checklist before committing a comment

1. Does removing it lose real information a future reader (or future me, in a fresh session) would need?
2. Does it explain **why**, not **what**?
3. Is it placed directly above the specific thing it justifies, not floating above a whole block?
4. Would it still be true if someone renamed a variable or reordered nearby code? If it references "the current fix" or "this PR," rewrite it to state the durable constraint instead.
