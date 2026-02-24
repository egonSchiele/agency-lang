import { Keyword, keywords, createKeyword } from "@/types/keyword.js";
import { Parser, capture, or, seqC, str, success } from "tarsec";
import { optionalSemicolon } from "./parserUtils.js";
import { optionalSpacesOrNewline } from "./utils.js";

export const keywordParser: Parser<Keyword> = (input) => {
  const parser = seqC(
    capture(or(...keywords.map(str)), "keyword"),
    optionalSemicolon,
  );
  const result = parser(input);
  if (!result.success) {
    return result;
  }
  const { keyword } = result.result;
  return success(createKeyword(keyword), result.rest);
};
