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
  return `__block_${counter}`;
}

export function isBlockName(name: string): boolean {
  return /^__block_\d+$/.test(name);
}
