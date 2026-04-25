import { Expression } from "../types.js";
import { BaseNode } from "./base.js";

export type SplatExpression = {
  type: "splat";
  value: Expression;
};

export type NamedArgument = {
  type: "namedArgument";
  name: string;
  value: Expression;
};

export type AgencyArray = BaseNode & {
  type: "agencyArray";
  items: (Expression | SplatExpression)[];
};

export type AgencyObjectKV = {
  key: string;
  value: Expression;
};
export type AgencyObject = BaseNode & {
  type: "agencyObject";
  entries: (AgencyObjectKV | SplatExpression)[];
};
