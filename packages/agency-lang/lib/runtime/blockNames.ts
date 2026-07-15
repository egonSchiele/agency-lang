/** Single source of truth for the compiler's anonymous-block naming scheme.
 *  The backend MINTS names via makeBlockName (stepPathTracker.nextBlockName);
 *  the runtime RECOGNIZES them via isBlockName (FunctionRefReviver's stub
 *  decision for unregistered refs). Keeping both here means the two
 *  subsystems cannot silently desync.
 *
 *  "__block_" is a de-facto reserved prefix: no diagnostic rejects a user
 *  function with such a name today, but misclassification requires a
 *  registry miss too, and the failure mode is a soft lazy-throwing stub. */
export function makeBlockName(counter: number): string {
  // isBlockName only recognizes \d+, so minting is restricted to the same
  // shape — otherwise this file's whole reason to exist (the two sides
  // cannot desync) would be false for non-integer input.
  if (!Number.isInteger(counter) || counter < 0) {
    throw new Error(
      `makeBlockName: counter must be a non-negative integer (got ${counter})`,
    );
  }
  return `__block_${counter}`;
}

export function isBlockName(name: string): boolean {
  return /^__block_\d+$/.test(name);
}
