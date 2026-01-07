import { AgencyNode } from "@/types";
import { ParserResult, Parser, sepBy, spaces, or, trace, debug } from "tarsec";
import { accessExpressionParser } from "./access";
import { assignmentParser } from "./assignment";
import { commentParser } from "./comment";
import { functionParser } from "./function";
import { functionCallParser } from "./functionCall";
import { literalParser } from "./literals";
import { matchBlockParser } from "./matchBlock";
import { returnStatementParser } from "./returnStatement";
import { usesToolParser } from "./tools";
import { typeAliasParser, typeHintParser } from "./typeHints";

export const bodyParser = trace(
  "functionBodyParser",
  (input: string): ParserResult<AgencyNode[]> => {
    const parser: Parser<AgencyNode[]> = sepBy(
      spaces,
      or(
        usesToolParser,
        debug(typeAliasParser, "error in typeAliasParser"),
        debug(typeHintParser, "error in typeHintParser"),
        returnStatementParser,
        matchBlockParser,
        functionParser,
        accessExpressionParser,
        assignmentParser,
        functionCallParser,
        literalParser,
        commentParser
      )
    );

    const result = parser(input);
    return result;
  }
);
