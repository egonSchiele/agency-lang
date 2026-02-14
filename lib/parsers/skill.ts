import { Skill } from "@/types/skill.js";
import {
  ParserResult,
  seqC,
  set,
  str,
  spaces,
  capture,
  manyWithJoin,
  noneOf,
  or,
  quotedString,
  map,
  trace,
} from "tarsec";
import { comma, optionalSpaces } from "./utils.js";

function removeQuotes(str: string): string {
  if (
    (str.startsWith('"') && str.endsWith('"')) ||
    (str.startsWith("'") && str.endsWith("'"))
  ) {
    return str.slice(1, -1);
  }
  return str;
}

export function _skillParser(input: string): ParserResult<Skill> {
  const parser = trace(
    "skillParser",
    seqC(
      set("type", "skill"),
      or(str("skills"), str("skill")),
      spaces,
      capture(map(quotedString, removeQuotes), "filepath"),
    ),
  );

  return parser(input);
}

export function _skillParserWithDescription(
  input: string,
): ParserResult<Skill> {
  const parser = trace(
    "skillParser",
    seqC(
      set("type", "skill"),
      or(str("skills"), str("skill")),
      spaces,
      capture(map(quotedString, removeQuotes), "filepath"),
      comma,
      capture(map(quotedString, removeQuotes), "description"),
    ),
  );

  return parser(input);
}

export const skillParser = (input: string) => {
  return or(_skillParserWithDescription, _skillParser)(input);
};
