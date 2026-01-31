import { Assignment } from "../types.js";
import {
  capture,
  char,
  many1WithJoin,
  or,
  Parser,
  seqC,
  set,
  trace,
} from "tarsec";
import { accessExpressionParser, indexAccessParser } from "./access.js";
import { agencyArrayParser, agencyObjectParser } from "./dataStructures.js";
import { functionCallParser } from "./functionCall.js";
import { literalParser } from "./literals.js";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpaces, varNameChar } from "./utils.js";
import { timeBlockParser } from "./function.js";

