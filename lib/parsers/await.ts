/* import { UsesTool } from "../types/tools.js";
import { capture, char, many1WithJoin, Parser, seqC, set } from "tarsec";
import { varNameChar } from "./utils.js";

export const usesToolParser: Parser<UsesTool> = seqC(
  set("type", "usesTool"),
  char("+"),
  capture(many1WithJoin(varNameChar), "toolName")
);
 */

import { AwaitStatement } from "@/types/await.js";
import { capture, or, Parser, ParserResult, seqC, set, spaces, str } from "tarsec";
import { accessExpressionParser } from "./access.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";

export const awaitParser = (input: string): ParserResult<AwaitStatement> => {
  const parser = seqC(
    set("type", "awaitStatement"),
    str("await"),
    spaces,
    capture(or(accessExpressionParser, functionCallParser, literalParser), "expression"),
  );
  return parser(input);
}