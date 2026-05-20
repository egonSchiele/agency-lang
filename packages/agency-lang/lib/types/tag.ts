import { BaseNode } from "./base.js";
import type { Expression } from "../types.js";

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: Expression[];
};
