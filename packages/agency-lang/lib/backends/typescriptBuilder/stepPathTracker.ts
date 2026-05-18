/**
 * Tracks the per-statement bookkeeping that the TypeScriptBuilder needs to
 * generate stepped function bodies, loop break/continue cleanup, and
 * uniquely-named block helpers.
 *
 * Four distinct concerns live here because they are all driven by the same
 * `processBodyAsParts` traversal and need to be threaded through the same
 * call chain:
 *
 * - **subStepPath**: integer path identifying the current statement inside a
 *   stepped body, e.g. `[3, 1]` means "statement 1 of the substep block
 *   that is statement 3 of the enclosing body". Used to name `__substep_*`
 *   helpers, build branch keys, and tag source-map / checkpoint records.
 * - **loopContextStack**: the substep key of every loop currently being
 *   emitted, so break/continue inside a nested loop knows which loop to
 *   target.
 * - **forkBlockDepth**: nesting level of fork/race block bodies. A non-zero
 *   value means we are inside another fork's block body, which changes how
 *   the inner block carries forward its `__bstack`.
 * - **blockCounter**: monotonically increasing counter used to mint unique
 *   `__block_<n>` names for emitted block helpers.
 */
export class StepPathTracker {
  private path: number[] = [];
  private loopStack: string[] = [];
  private forkDepth: number = 0;
  private blockCounter: number = 0;

  // ---- substep path ----

  push(id: number): void {
    this.path.push(id);
  }

  pop(): void {
    this.path.pop();
  }

  /** The last id in the path; throws if the path is empty. */
  currentId(): number {
    if (this.path.length === 0) {
      throw new Error("StepPathTracker: currentId() called with empty path");
    }
    return this.path[this.path.length - 1];
  }

  /** Joined string form, e.g. `"3.1.0"`. Used for branch keys and interrupt ids. */
  joined(separator: string = "."): string {
    return this.path.join(separator);
  }

  /** Defensive copy of the current path, e.g. for source-map records. */
  snapshot(): number[] {
    return [...this.path];
  }

  // ---- loop-context stack (for break/continue cleanup) ----

  pushLoop(subKey: string): void {
    this.loopStack.push(subKey);
  }

  popLoop(): void {
    this.loopStack.pop();
  }

  /** Sub-key of the innermost enclosing stepped loop, or undefined if none. */
  currentLoopKey(): string | undefined {
    return this.loopStack[this.loopStack.length - 1];
  }

  // ---- fork-block nesting depth ----

  enterForkBlock(): void {
    this.forkDepth++;
  }

  exitForkBlock(): void {
    this.forkDepth--;
  }

  isNestedInForkBlock(): boolean {
    return this.forkDepth > 0;
  }

  // ---- block-helper naming ----

  /** Returns the next unique `__block_<n>` name. */
  nextBlockName(): string {
    return `__block_${this.blockCounter++}`;
  }
}
