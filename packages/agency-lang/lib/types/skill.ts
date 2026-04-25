import { BaseNode } from "./base.js";

export type Skill = BaseNode & {
  type: "skill";
  filepath: string;
  description?: string;
};
