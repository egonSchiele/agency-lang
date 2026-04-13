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
import { valueAccessParser } from "./parsers/access.js";
import { binOpParser } from "./parsers/binop.js";
import { commentParser } from "./parsers/comment.js";
import { forLoopParser } from "./parsers/forLoop.js";
import {
  assignmentParser,
  functionParser,
  graphNodeParser,
  handleBlockParser,
  ifParser,
  messageThreadParser,
  sharedAssignmentParser,
  whileLoopParser,
  withModifierParser,
} from "./parsers/function.js";
import {
  importNodeStatmentParser,
  importStatmentParser,
  importToolStatmentParser,
} from "./parsers/importStatement.js";
import { keywordParser } from "./parsers/keyword.js";
import { booleanParser } from "./parsers/literals.js";
import { matchBlockParser } from "./parsers/matchBlock.js";
import { multiLineCommentParser } from "./parsers/multiLineComment.js";
import { newLineParser } from "./parsers/newline.js";
import { returnStatementParser } from "./parsers/returnStatement.js";
import { debuggerParser } from "./parsers/debuggerStatement.js";
import { skillParser } from "./parsers/skill.js";
import { specialVarParser } from "./parsers/specialVar.js";
import { tagParser } from "./parsers/tag.js";
import { usesToolParser } from "./parsers/tools.js";
import { typeAliasParser } from "./parsers/typeHints.js";
import { AgencyNode, AgencyProgram } from "./types.js";
import { optionalSpacesOrNewline } from "./parsers/utils.js";

const nodeParser = or(
  keywordParser,
  usesToolParser,
  importNodeStatmentParser,
  importToolStatmentParser,
  importStatmentParser,
  graphNodeParser,
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
  specialVarParser,
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
