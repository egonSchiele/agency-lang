import {
  char,
  GeneralParser,
  MergedCaptures,
  optional,
  or,
  Parser,
  seqC,
  str,
} from "tarsec";

export const optionalSemicolon = optional(char(";"));

export function removeQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

export const oneOfStr = <T extends string>(strs: readonly T[]): Parser<T> => {
  return or(...strs.map((s) => str(s)));
};
