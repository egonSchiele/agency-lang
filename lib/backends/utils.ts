import { ADLNode, ReturnStatement } from "@/types";

export const wrapInReturn = (node: ADLNode): ReturnStatement => {
  return {
    type: "returnStatement",
    value: node,
  };
};
