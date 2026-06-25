import {
  buildLineTable,
  capture,
  eof,
  getErrorMessage,
  getRightmostFailure,
  many,
  map,
  offsetToPosition,
  or,
  Parser,
  ParserResult,
  resetMemos,
  seqC,
  set,
  setInputStr,
  setTraceHost,
  setTraceId,
  success,
  TarsecError,
  trace,
} from "tarsec";

import { nanoid } from "nanoid";
import { AgencyConfig } from "./config.js";
import { lowerPatterns, PatternLoweringError } from "./lowering/patternLowering.js";
import render from "./templates/backends/agency/template.js";
import {
  assignmentParser,
  binOpParser,
  booleanParser,
  commentParser,
  debuggerParser,
  forLoopParser,
  functionParser,
  gotoStatementParser,
  graphNodeParser,
  handleBlockParser,
  ifParser,
  exportFromStatementParser,
  importNodeStatmentParser,
  importStatmentParser,
  interruptStatementParser,
  raiseStatementParser,
  keywordParser,
  matchBlockParser,
  messageThreadParser,
  multiLineCommentParser,
  newLineParser,
  blankLineParser,
  BLANK_LINE_SENTINEL,
  optionalSpacesOrNewline,
  returnStatementParser,
  modifiedAssignmentParser,
  staticStatementParser,
  skillParser,
  tagParser,
  typeAliasParser,
  effectSetDeclParser,
  effectDeclParser,
  valueAccessParser,
  whileLoopParser,
  withModifierParser,
  reservedClassParser,
  AGENCY_TEMPLATE_OFFSET,
  setTemplateOffset,
} from "./parsers/parsers.js";
import { AgencyNode, AgencyProgram } from "./types.js";

const nodeParser = or(
  keywordParser,
  importNodeStatmentParser,
  importStatmentParser,
  exportFromStatementParser,
  graphNodeParser,
  reservedClassParser,
  effectSetDeclParser,
  effectDeclParser,
  typeAliasParser,
  ifParser,
  forLoopParser,
  whileLoopParser,
  matchBlockParser,
  messageThreadParser,
  handleBlockParser,
  debuggerParser,
  skillParser,
  functionParser,
  returnStatementParser,
  gotoStatementParser,
  raiseStatementParser,
  interruptStatementParser,
  tagParser,
  withModifierParser,
  modifiedAssignmentParser,
  staticStatementParser,
  assignmentParser,
  binOpParser,
  booleanParser,
  valueAccessParser,
  multiLineCommentParser,
  commentParser,
  blankLineParser,
  newLineParser,
);

export const agencyNode: Parser<AgencyNode[]> = (input: string) => {
  const parser = many(
    trace(
      "agencyParser",
      map(
        seqC(capture(nodeParser, "node"), optionalSpacesOrNewline),
        (result) => result.node,
      ),
    ),
  );

  return parser(input);
};

export const agencyParser: Parser<AgencyProgram> = seqC(
  set("type", "agencyProgram"),
  capture(agencyNode, "nodes"),
  eof,
);

export const normalizeCode = (code: string) => {
  return code;
};

export function replaceBlankLines(input: string): string {
  return input.replace(/(\r?\n)(\r?\n)+/g, (match) =>
    BLANK_LINE_SENTINEL.repeat(match.length - 1) + "\n"
  );
}

/** Failure result enriched with the tarsec rightmost-failure position so
 *  the LSP can surface a real squiggle range instead of falling back to
 *  line 0, col 0. `pos` is a byte offset into the normalized input. */
export type ParserFailureWithPos = {
  success: false;
  message: string;
  rest: string;
  rightmostPos?: number;
};

/**
 * Raw parse entry point. Normalizes the source, primes tarsec's
 * input-string / memo state, runs the top-level `agencyParser`, and
 * returns the result with an optional `rightmostPos` so callers can
 * recover an editor-coordinate location for recoverable failures.
 *
 * Difference vs `parseAgency`:
 *   - `_parseAgency` is the **raw** parse. It does NOT wrap the source
 *     in the CLI template prelude, does NOT run the pattern-lowering
 *     pass, and does NOT catch `TarsecError` / `PatternLoweringError`
 *     — those exceptions propagate to the caller as-is.
 *   - `parseAgency` is the **user-facing** layer. It optionally renders
 *     the template (which prepends stdlib imports the CLI auto-injects),
 *     runs the lowering pass on success, and converts thrown errors
 *     into a structured `ParseAgencyResult` with `errorData` populated
 *     so the LSP / CLI can render a useful diagnostic.
 *
 * Exported because `scripts/agency.ts diagnostics` calls it directly
 * to get raw tarsec error data without the higher-level wrapping.
 */
export function _parseAgency(
  input: string,
  config: AgencyConfig = {},
): ParserResult<AgencyProgram> | ParserFailureWithPos {
  const normalized = normalizeCode(input);
  if (normalized.trim().length === 0) {
    return success(
      {
        type: "agencyProgram",
        nodes: [],
      },
      "",
    );
  }
  setInputStr(normalized);
  // Clear memo caches so loc info derived from `setInputStr` in a previous
  // parse (which may have used a different source) doesn't leak through.
  resetMemos();
  if (config.tarsecTraceHost) {
    setTraceHost("http://localhost:1465");
    setTraceId(nanoid());
  }
  const result = agencyParser(normalized);
  if (!result.success) {
    const betterMessage = getErrorMessage();
    const rightmost = getRightmostFailure();
    if (betterMessage) {
      return {
        success: false,
        message: betterMessage,
        rest: normalized,
        ...(rightmost ? { rightmostPos: rightmost.pos } : {}),
      };
    }
    if (rightmost) {
      return {
        success: false,
        message: result.message ?? "Parse error",
        rest: normalized,
        rightmostPos: rightmost.pos,
      };
    }
  }
  return result;
}

export type ParseAgencyErrorData = {
  line: number;
  column: number;
  length: number;
  message: string;
  prettyMessage: string;
};

export type ParseAgencyResult =
  | { success: true; result: AgencyProgram; rest: string }
  | { success: false; message?: string; rest: string; errorData?: ParseAgencyErrorData };

/**
 * Build a structured `ParseAgencyErrorData` from a tarsec
 * rightmost-failure offset (or a fallback `{line, column, length}` if
 * one isn't available). When `rightmostPos` is provided we recompute
 * line/col from the absolute offset via `offsetToPosition` —
 * deliberately ignoring any line/col tarsec might have computed
 * itself, because tarsec's `getDiagnostics` undercounts `\n`
 * separators when walking its line table and that drifts columns
 * right by the number of preceding newlines once the template wrapper
 * is applied. Used by both the recoverable-failure branch and the
 * `TarsecError` branch in `parseAgency`.
 */
function buildErrorData(
  input: string,
  rightmostPos: number | null,
  offset: number,
  fallback: { line: number; column: number; length: number },
  message: string,
  prettyMessage: string,
): ParseAgencyErrorData {
  if (rightmostPos != null) {
    const pos = offsetToPosition(buildLineTable(input), rightmostPos);
    return {
      line: pos.line - offset,
      column: pos.column,
      length: fallback.length,
      message,
      prettyMessage,
    };
  }
  return { ...fallback, message, prettyMessage };
}

export function parseAgency(
  input: string,
  config: AgencyConfig = {},
  applyTemplate: boolean = true,
  lower: boolean = true,
): ParseAgencyResult {
  if (applyTemplate) {
    input = render({ body: input });
  }
  // The parser adds locs by subtracting `currentTemplateOffset` from
  // tarsec spans. When the template was applied, spans are shifted by
  // AGENCY_TEMPLATE_OFFSET (the prelude lines); when not, no shift. Net
  // effect: loc.line is always 0-indexed in the user's source.
  const offset = applyTemplate ? AGENCY_TEMPLATE_OFFSET : 0;
  setTemplateOffset(offset);
  try {
    const result = _parseAgency(input, config);
    if (result.success) {
      if (lower) {
        // Apply pattern lowering pass: transforms destructuring/pattern syntax
        // into existing AST constructs. The format path opts out by passing
        // `lower: false` so it can print patterns back as patterns.
        result.result.nodes = lowerPatterns(result.result.nodes);
      }
      return result;
    }
    // Recoverable parse failure (no TarsecError thrown). Convert the
    // tarsec rightmost-failure offset into editor-coordinate line/col
    // so the LSP can anchor its squiggle on the actual error site
    // instead of falling back to line 0, col 0. Without this, the
    // diagnostics layer only has the message string to go on, and the
    // location info embedded in that string ("Line X, col Y: ...") is
    // never extracted.
    const rightmostPos =
      "rightmostPos" in result && typeof result.rightmostPos === "number"
        ? result.rightmostPos
        : null;
    if (rightmostPos != null) {
      // Strip the "Line X, col Y: " prefix that getErrorMessage prepends
      // so the LSP / CLI can render the location separately without
      // duplicating it inside the message body.
      const cleanMessage = result.message.replace(/^Line \d+, col \d+: /, "");
      return {
        success: false,
        message: result.message,
        rest: input,
        errorData: buildErrorData(
          input,
          rightmostPos,
          offset,
          { line: 0, column: 0, length: 1 },
          cleanMessage,
          result.message,
        ),
      };
    }
    return { success: false, message: result.message, rest: result.rest };
  } catch (error) {
    if (error instanceof TarsecError) {
      const rightmost = getRightmostFailure();
      return {
        success: false,
        message: error.message,
        rest: input,
        errorData: buildErrorData(
          input,
          rightmost ? rightmost.pos : null,
          offset,
          // Fallback line is already in templated coordinates; subtract
          // the template offset here so the user sees user-source lines
          // either way (the rightmost-offset path subtracts inside the
          // helper).
          { line: error.data.line - offset, column: error.data.column, length: error.data.length },
          error.data.message,
          error.data.prettyMessage,
        ),
      };
    } else if (error instanceof PatternLoweringError) {
      // Compile-time error from the lowering pass (e.g. shorthand binder in
      // pure-boolean `is` context). Surface as a normal failed parse so the
      // CLI / LSP show it as a diagnostic instead of a stack trace.
      return {
        success: false,
        message: error.message,
        rest: input,
        errorData: {
          line: error.loc ? error.loc.line : 0,
          column: error.loc ? error.loc.col : 0,
          length: error.loc ? Math.max(1, error.loc.end - error.loc.start) : 1,
          message: error.message,
          prettyMessage: error.message,
        },
      };
    } else {
      throw error;
    }
  } finally {
    setTemplateOffset(0);
  }
}
