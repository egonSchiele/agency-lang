import { char, many, oneOf, Parser, seqR, space } from "tarsec";

export const optionalSpacesOrNewline = many(space);
export const optionalSpaces = many(oneOf(" \t"));
export const backtick = char("`");
export const comma = seqR(optionalSpaces, char(","), optionalSpaces);
export const commaWithNewline = seqR(
  optionalSpacesOrNewline,
  char(","),
  optionalSpacesOrNewline,
);
export const varNameChar: Parser<string> = oneOf(
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_",
);
