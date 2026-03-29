import { Parser, withSpan } from "tarsec";
import { SourceLocation } from "../types/base.js";

/**
 * Wraps a parser to add a `loc` field from tarsec's withSpan.
 * Converts Span { start: Position, end: Position } to SourceLocation { line, col, start, end }.
 */
export function withLoc<T>(parser: Parser<T>): Parser<T & { loc: SourceLocation }> {
  const spanned = withSpan(parser);
  return (input: string) => {
    const result = spanned(input);
    if (!result.success) return result;
    const { value, span } = result.result;
    const loc: SourceLocation = {
      line: span.start.line,
      col: span.start.column,
      start: span.start.offset,
      end: span.end.offset,
    };
    return {
      success: true as const,
      result: { ...value, loc } as T & { loc: SourceLocation },
      rest: result.rest,
    };
  };
}
