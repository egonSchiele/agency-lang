import { handled, rejected, paused, hasInterrupts, approve, respondToInterrupts } from "./agent.js";

// Every import above has been evaluated by now. From here on, a call into a
// Node module that has no stand-in throws.
globalThis.__nodeStubStrict = true;

async function run() {
  const out = {};
  out.engine = typeof navigator !== "undefined" ? navigator.userAgent : "no navigator";
  out.hasNodeProcess = typeof process !== "undefined" && !!(process.versions && process.versions.node);
  out.hasNativeAsyncContext = typeof AsyncContext !== "undefined";
  out.handled = (await handled()).data;
  out.rejected = (await rejected()).data;
  const a = await paused("a", 30);
  const b = await paused("b", 5);
  out.pausedBoth = hasInterrupts(a.data) && hasInterrupts(b.data);
  const results = await Promise.all([
    respondToInterrupts(a.data, [approve()]),
    respondToInterrupts(b.data, [approve()]),
  ]);
  out.resumedA = results[0].data;
  out.resumedB = results[1].data;
  out.nodeApisCalledWhileRunning = globalThis.__nodeStubCalls || {};
  out.nodeApisUsedWhileLoading = globalThis.__nodeStubAtLoad || {};
  return out;
}

run().then(
  (out) => globalThis.__report(JSON.stringify(out, null, 2)),
  (err) => globalThis.__report("FAILED: " + (err && err.stack ? err.stack : String(err)) + "\nnode APIs called: " + JSON.stringify(globalThis.__nodeStubCalls || {})),
);
