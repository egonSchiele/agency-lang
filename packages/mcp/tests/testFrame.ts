import { agency, RuntimeContext, ThreadStore, type Run } from "agency-lang/runtime";

/**
 * Run `fn` inside an Agency execution frame.
 *
 * An Agency function is invoked with the run it is called under. A test
 * that calls `fn.invoke(run, ...)` directly gets that run here.
 */
export function inTestFrame<T>(fn: (run: Run) => T): T {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
  return agency.withTestContext({ ctx, stack: ctx.stateStack, threads: new ThreadStore() }, fn);
}
