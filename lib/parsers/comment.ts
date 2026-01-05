import { AgencyComment } from "@/types";
import { Parser, seqC, set, str, capture, many1Till, newline } from "tarsec";
import { optionalSpaces } from "./utils";
export const commentParser: Parser<AgencyComment> = (input: string) => {
  const parser = seqC(
    set("type", "comment"),
    optionalSpaces,
    str("//"),
    capture(many1Till(newline), "content")
  );
  return parser(input);
};
