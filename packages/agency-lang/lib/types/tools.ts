import { BaseNode } from "./base.js";

export type UsesTool = BaseNode & {
  type: "usesTool";
  toolNames: string[];
};
