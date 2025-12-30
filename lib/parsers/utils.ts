import { char, many, space } from "tarsec";

export const optionalSpaces = many(space);
export const backtick = char("`");
