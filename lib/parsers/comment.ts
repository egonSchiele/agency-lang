import { AgencyComment } from "../types.js";
import {
  Parser,
  seqC,
  set,
  str,
  capture,
  many1Till,
  newline,
  manyTill,
} from "tarsec";
import { optionalSpaces } from "./utils.js";
export const commentParser: Parser<AgencyComment> = (input: string) => {
  const parser = seqC(
    set("type", "comment"),
    optionalSpaces,
    str("//"),
    capture(manyTill(newline), "content"),
  );
  return parser(input);
};
