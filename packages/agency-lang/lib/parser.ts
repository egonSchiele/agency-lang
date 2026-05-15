import {
  capture,
  eof,
  failure,
  getErrorMessage,
  many,
  map,
  or,
  Parser,
  ParserResult,
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
import { lowerPatterns } from "./lowering/patternLowering.js";
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
  skillParser,
  tagParser,
  typeAliasParser,
  valueAccessParser,
  whileLoopParser,
  withModifierParser,
  classParser,
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
  classParser,
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

export function _parseAgency(
  input: string,
  config: AgencyConfig = {},
): ParserResult<AgencyProgram> {
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
  if (config.tarsecTraceHost) {
    setTraceHost("http://localhost:1465");
    setTraceId(nanoid());
  }
  const result = agencyParser(normalized);
  if (!result.success) {
    const betterMessage = getErrorMessage();
    if (betterMessage) {
      return failure(betterMessage, normalized);
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
    if (result.success && lower) {
      // Apply pattern lowering pass: transforms destructuring/pattern syntax
      // into existing AST constructs. The format path opts out by passing
      // `lower: false` so it can print patterns back as patterns.
      result.result.nodes = lowerPatterns(result.result.nodes);
    }
    return result;
  } catch (error) {
    if (error instanceof TarsecError) {
      return {
        success: false,
        message: error.message,
        rest: input,
        errorData: {
          line: error.data.line - offset,
          column: error.data.column,
          length: error.data.length,
          message: error.data.message,
          prettyMessage: error.data.prettyMessage,
        },
      };
    } else {
      throw error;
    }
  } finally {
    setTemplateOffset(0);
  }
}
