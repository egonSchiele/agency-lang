export type SourceLocation = {
  nodeId: string;
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** The branch keys from the root stack down to the stack the step ran
   *  on. Absent or empty for a step on the root stack. */
  branchPath?: string[];
};
