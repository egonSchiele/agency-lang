import { AgencyMultiLineComment } from "../types.js";
import {
  Parser,
  anyChar,
  between,
  capture,
  map,
  seqC,
  set,
  str,
} from "tarsec";
import { optionalSpaces } from "./utils.js";

const joinChars = (chars: string[]) => chars.join("");

export const multiLineCommentParser: Parser<AgencyMultiLineComment> = (
  input: string,
) => {
  const parser = seqC(
    set("type", "multiLineComment"),
    optionalSpaces,
    capture(map(between(str("/*"), str("*/"), anyChar), joinChars), "content"),
  );
  return parser(input);
};
