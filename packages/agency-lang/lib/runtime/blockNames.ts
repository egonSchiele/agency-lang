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

/** The preprocessor's lifted-callback naming scheme. liftCallbacks MINTS
 *  `__cb_<scope>_<n>` (importing LIFTED_CALLBACK_PREFIX from here); the
 *  runtime RECOGNIZES those names via isLiftedCallbackName in
 *  FunctionRefReviver. Same cannot-desync contract as makeBlockName /
 *  isBlockName above, and "__cb_" is a de-facto reserved prefix the same
 *  way "__block_" is.
 *
 *  WHY THE TWO FAMILIES GET DIFFERENT STUBS ON A REGISTRY MISS:
 *  a `__block_*` ref revives as a TRIPWIRE that throws if invoked, because
 *  replay rebinds block arguments unconditionally at function entry before
 *  anything can call them -- a firing tripwire means a runtime bug. A
 *  `__cb_*` ref revives as a LAZY REF that resolves through the registry at
 *  invoke time, because nothing rebinds a scoped-callback registration on
 *  replay (the callback() statement is step-skipped on resume) -- the
 *  revived entry IS the registration and may legitimately fire. */
export const LIFTED_CALLBACK_PREFIX = "__cb";

export function isLiftedCallbackName(name: string): boolean {
  return /^__cb_.+_\d+$/.test(name);
}
