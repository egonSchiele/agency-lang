import { char, optional, or, Parser, str } from "tarsec";

export const optionalSemicolon = optional(char(";"));

export const oneOfStr = <T extends string>(strs: readonly T[]): Parser<T> => {
  return or(...strs.map((s) => str(s)));
};
