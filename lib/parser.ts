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
  graphNodeParser,
  handleBlockParser,
  ifParser,
  importNodeStatmentParser,
  importStatmentParser,
  importToolStatmentParser,
  keywordParser,
  matchBlockParser,
  messageThreadParser,
  multiLineCommentParser,
  newLineParser,
  optionalSpacesOrNewline,
  returnStatementParser,
  sharedAssignmentParser,
  skillParser,
  tagParser,
  typeAliasParser,
  usesToolParser,
  valueAccessParser,
  whileLoopParser,
  withModifierParser,
  classParser,
} from "./parsers/parsers.js";
import { AgencyNode, AgencyProgram } from "./types.js";

const nodeParser = or(
  keywordParser,
  usesToolParser,
  importNodeStatmentParser,
  importToolStatmentParser,
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
  tagParser,
  sharedAssignmentParser,
  withModifierParser,
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

export function parseAgency(
  input: string,
  config: AgencyConfig = {},
  applyTemplate: boolean = true,
): ParserResult<AgencyProgram> {
  if (applyTemplate) {
    input = render({ body: input });
  }
  try {
    return _parseAgency(input, config);
  } catch (error) {
    if (error instanceof TarsecError) {
      console.log(error.data.prettyMessage);
      return failure(error.message, input);
    } else {
      throw error;
    }
  }
}
