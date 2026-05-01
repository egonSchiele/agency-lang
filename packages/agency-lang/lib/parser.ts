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
  importNodeStatmentParser,
  importStatmentParser,
  keywordParser,
  matchBlockParser,
  messageThreadParser,
  multiLineCommentParser,
  newLineParser,
  optionalSpacesOrNewline,
  returnStatementParser,
  staticAssignmentParser,
  skillParser,
  tagParser,
  typeAliasParser,
  valueAccessParser,
  whileLoopParser,
  withModifierParser,
  classParser,
} from "./parsers/parsers.js";
import { AgencyNode, AgencyProgram } from "./types.js";

const nodeParser = or(
  keywordParser,
  importNodeStatmentParser,
  importStatmentParser,
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
  tagParser,
  withModifierParser,
  staticAssignmentParser,
  assignmentParser,
  binOpParser,
  booleanParser,
  valueAccessParser,
  multiLineCommentParser,
  commentParser,
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
): ParseAgencyResult {
  if (applyTemplate) {
    input = render({ body: input });
  }
  try {
    return _parseAgency(input, config);
  } catch (error) {
    if (error instanceof TarsecError) {
      return {
        success: false,
        message: error.message,
        rest: input,
        errorData: {
          line: error.data.line,
          column: error.data.column,
          length: error.data.length,
          message: error.data.message,
          prettyMessage: error.data.prettyMessage,
        },
      };
    } else {
      throw error;
    }
  }
}
