/**
 * Build a memoized async getter for one top-level static or global
 * variable. The returned function:
 *
 *   1. On synchronous re-entry while compute's sync prefix is still
 *      running → throw with the var name. This is the cycle-detection
 *      path. JS async functions run synchronously up to the first
 *      `await`; the codegen places cross-module init reads
 *      (`await __init_X(__ctx)`) at the head of compute bodies, so a
 *      cyclic dependency chain re-enters the original `__init_X`
 *      synchronously and hits the `running` flag BEFORE any await
 *      suspends.
 *   2. On subsequent calls after compute's sync prefix has returned a
 *      promise → return the memoized promise. Compute runs exactly
 *      once. (`running` is reset as soon as `compute(ctx)` returns its
 *      promise — purely-outside concurrent callers do NOT trip the
 *      cycle detector because they only re-enter after compute has
 *      yielded on its first await.)
 *   3. The compute body itself awaits its OWN deps via other
 *      `__init_*` calls — the cascade encodes the dep DAG without a
 *      centralized topological sort.
 *
 * Failure semantics: PERMANENT FAILURE. If `compute` rejects, the
 * rejected promise is cached and returned on every subsequent call.
 * Re-attempting an init that already failed is a footgun — once a
 * top-level value's compute body throws, every consumer of that value
 * sees the same diagnosable error rather than racing into different
 * partial-init states.
 *
 * This is the only place in the codebase where init orchestration
 * logic lives. Codegen produces pure data (a compute closure +
 * the var name for error reporting); the runtime owns the "how."
 */
/**
 * Validate that a cross-module `__init_X` import resolved to a real
 * getter function. Emitted by codegen once per cross-module init
 * import; runs at module load time so the failure mode is "module
 * fails to load with a clear pointer at the broken dep" rather than
 * "node runs partway, then crashes with `TypeError: __init_X is not
 * a function` at first use."
 *
 * Triggered when the source module was compiled by an older
 * agency-lang that pre-dates the cross-module init export shape, or
 * when a `pkg::` import points to an Agency package whose published
 * `.js` files are stale.
 */
export function __requireInitVar(
  fn: unknown,
  varName: string,
  modulePath: string,
): void {
  if (typeof fn === "function") return;
  throw new Error(
    `${modulePath} was compiled with an older agency-lang version and ` +
      `is missing the cross-module init export for "${varName}". ` +
      "Rebuild the imported module with the current toolchain (`make`).",
  );
}

export function __initVar<T, Ctx>(
  varName: string,
  compute: (ctx: Ctx) => Promise<T>,
): (ctx: Ctx) => Promise<T> {
  let running = false;
  let p: Promise<T> | null = null;
  return (ctx) => {
    // Order matters: check `running` BEFORE the memoized promise.
    // During cyclic re-entry both `running` is true and `p` is null
    // (we set running before assigning p), so this branch fires first.
    if (running) {
      throw new Error(
        `Init cycle on ${varName}. The dependency chain that led here ` +
        `appears in the JS stack trace above (every frame named ` +
        `\`__init_*\` is a participating variable). To fix, restructure ` +
        `so the dependency is not circular — typically by moving one of ` +
        `the values into a \`def\` that runs after initialization.`,
      );
    }
    if (p) return p;
    running = true;
    // compute is async — calling it executes its sync prefix and
    // returns a Promise. The sync prefix is the cycle-detection
    // window: any `__init_*` re-entry that happens here lands while
    // `running` is still true. As soon as compute's prefix yields on
    // its first await, the call below returns and we drop `running`
    // back to false so external concurrent callers don't trip the
    // detector.
    let computePromise: Promise<T>;
    try {
      computePromise = compute(ctx);
    } finally {
      running = false;
    }
    p = computePromise;
    return p;
  };
}
