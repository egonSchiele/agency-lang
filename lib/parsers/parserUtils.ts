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

export const oneOfStr = <T extends string>(strs: readonly T[]): Parser<T> => {
  return or(...strs.map((s) => str(s)));
};

export function throwErrorUnless<
  const T extends readonly GeneralParser<any, any>[],
>(_message: string, ...parsers: T): Parser<MergedCaptures<T>> {
  //export function throwError<T>(parser: Parser<T>, _message: string): Parser<T> {
  return (input) => {
    const result = seqC(...parsers)(input);
    if (result.success) {
      return result;
    } else {
      const message = [`near ${input.substring(1, 100)}`, _message].join("\n");
      throw new Error(message);
    }
  };
}
