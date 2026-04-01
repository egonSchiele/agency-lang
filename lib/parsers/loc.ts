import { Parser, withSpan } from "tarsec";
import { SourceLocation } from "../types/base.js";

/* withLoc at appends accurate line and column numbers to different symbols in the agency code.
However, because every agency code gets rendered in a template that imports some standard functions,
the line numbers would be off if we didn't account for the template lines.
*/
const AGENCY_TEMPLATE_OFFSET = 2;

/**
 * Wraps a parser to add a `loc` field from tarsec's withSpan.
 * Converts Span { start: Position, end: Position } to SourceLocation { line, col, start, end }.
 */
export function withLoc<T>(
  parser: Parser<T>,
): Parser<T & { loc: SourceLocation }> {
  const spanned = withSpan(parser);
  return (input: string) => {
    const result = spanned(input);
    if (!result.success) return result;
    const { value, span } = result.result;
    const loc: SourceLocation = {
      line: span.start.line - AGENCY_TEMPLATE_OFFSET,
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
