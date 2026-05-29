import { markdownParser } from "tarsec/parsers/markdown";

export type MarkdownParseResult = {
  success: boolean;
  blocks: unknown[];
  error: string;
  rest: string;
};

/** Parse a Markdown string into an array of block nodes using tarsec's
 *  Markdown parser. Returns an object with `success`, the parsed `blocks`,
 *  a textual `error` message (empty on success), and any unconsumed input
 *  in `rest`. */
export function _parseMarkdown(input: string): MarkdownParseResult {
  const res = markdownParser(input);
  if (res.success) {
    return {
      success: true,
      blocks: res.result as unknown[],
      error: "",
      rest: res.rest ?? "",
    };
  }
  return {
    success: false,
    blocks: [],
    error: res.message,
    rest: res.rest ?? "",
  };
}
