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
    if ("rightmostPos" in result && typeof result.rightmostPos === "number") {
      const lineTable = buildLineTable(input);
      const pos = offsetToPosition(lineTable, result.rightmostPos);
      // Strip the "Line X, col Y: " prefix that getErrorMessage prepends
      // so the LSP / CLI can render the location separately without
      // duplicating it inside the message body.
      const message = result.message.replace(/^Line \d+, col \d+: /, "");
      return {
        success: false,
        message: result.message,
        rest: input,
        errorData: {
          line: pos.line - offset,
          column: pos.column,
          length: 1,
          message,
          prettyMessage: result.message,
        },
      };
    }
    return { success: false, message: result.message, rest: result.rest };
  } catch (error) {
    if (error instanceof TarsecError) {
      // Prefer the rightmost-failure offset over tarsec's own
      // line/column. tarsec's `getDiagnostics` line/col computation
      // ignores `\n` separators when walking the line table, which
      // makes columns drift right by the number of preceding
      // newlines once the template is applied. Recomputing from
      // the absolute offset avoids that drift entirely.
      const rightmost = getRightmostFailure();
      let line = error.data.line - offset;
      let column = error.data.column;
      if (rightmost) {
        const pos = offsetToPosition(buildLineTable(input), rightmost.pos);
        line = pos.line - offset;
        column = pos.column;
      }
      return {
        success: false,
        message: error.message,
        rest: input,
        errorData: {
          line,
          column,
          length: error.data.length,
          message: error.data.message,
          prettyMessage: error.data.prettyMessage,
        },
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
