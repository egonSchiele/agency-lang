import { agency, RuntimeContext, ThreadStore } from "agency-lang/runtime";

/**
 * Run `fn` inside an Agency execution frame.
 *
 * An Agency function keeps its call depth on the frame, so invoking one
 * with no frame throws. A test that calls `fn.invoke(...)` directly needs
 * a frame around the call.
 */
export function inTestFrame<T>(fn: () => T): T {
  const ctx = new RuntimeContext({
    statelogConfig: { host: "", apiKey: "", projectId: "", debugMode: false },
    smoltalkDefaults: {},
    dirname: process.cwd(),
  });
  return agency.withTestContext({ ctx, stack: ctx.stateStack, threads: new ThreadStore() }, fn);
}
