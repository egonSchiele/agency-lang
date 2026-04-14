import { BaseNode } from "./base.js";

export type Tag = BaseNode & {
  type: "tag";
  name: string;
  arguments: string[];
};
