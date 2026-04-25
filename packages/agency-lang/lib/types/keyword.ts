import { BaseNode } from "./base.js";

export const keywords = ["break", "continue"] as const;

export type KeywordValue = (typeof keywords)[number];

export type Keyword = BaseNode & {
  type: "keyword";
  value: KeywordValue;
};

export function createKeyword(value: KeywordValue): Keyword {
  return { type: "keyword", value };
}

export function isKeyword(value: string): value is KeywordValue {
  return (keywords as readonly string[]).includes(value);
}
