import { char, many, seqR, space } from "tarsec";

export const optionalSpaces = many(space);
export const backtick = char("`");
export const comma = seqR(optionalSpaces, char(","), optionalSpaces);
