export type SourceLocation = {
  nodeId: string;
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** The branch keys from the root stack down to the stack the step ran
   *  on. Absent or empty for a step on the root stack. */
  branchPath?: string[];
  /** Set when the location is one of the tool loop's own stops, before a
   *  model request (`round`) or before a tool call (`tool`), rather than
   *  a statement. Such a location is under the `llm()` statement: its
   *  `stepPath` is the statement's path, a slash, and the loop's step key. */
  loopStop?: LoopStopKind;
};

export type LoopStopKind = "round" | "tool";
