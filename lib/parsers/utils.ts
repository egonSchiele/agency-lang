import { char, many, oneOf, Parser, seqR, space } from "tarsec";

export const optionalSpaces = many(space);
export const backtick = char("`");
export const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const varNameChar: Parser<string> = oneOf(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"
);
