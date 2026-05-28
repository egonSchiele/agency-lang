/**
 * `HaltSignal` — internal sentinel thrown by TS helpers (currently only
 * `agency.interrupt()`) to unwind a step body after the runner has been
 * halted. Mirrors the codegen `runner.halt(...); return;` pattern: in
 * generated code the explicit `return` stops execution of the rest of
 * the step body; from inside a TS helper we have no way to make the
 * caller `return`, so we throw this signal and let the surrounding
 * `Runner.step` (or `withResumableScope`) catch it once `runner.halted`
 * is true.
 *
 * Kept in its own module to avoid an import cycle between `runner.ts`
 * (which catches it) and `agencyInterrupt.ts` (which throws it).
 *
 * Not exported from the public `agency.*` namespace: users should never
 * see this class. If a `HaltSignal` ever surfaces to a user `.catch(...)`
 * handler it is a bug — the catch in `Runner.step` should always absorb
 * it before user code runs.
 */
export class HaltSignal extends Error {
  constructor() {
    super("Runner halted by agency.interrupt()");
    this.name = "HaltSignal";
  }
}
