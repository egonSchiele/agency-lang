import { BaseNode } from "./base.js";

export type TryExpression = BaseNode & {
  type: "tryExpression";
  call: {
    type: "functionCall";
    functionName: string;
    arguments: any[];
    block?: any;
    safe?: boolean;
  };
};
