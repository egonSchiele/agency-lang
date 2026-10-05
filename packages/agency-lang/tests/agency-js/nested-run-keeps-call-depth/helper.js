import { getRuntimeContext } from "agency-lang/runtime";
import { inner } from "./agent.js";

// Starts the `inner` node as a new run, from inside the run that called this
// helper. It starts the node before any await, which is when the outer run
// is still readable.
export function startInnerNode() {
  return inner().then((result) => result.data);
}

// How many Agency function calls deep the caller is.
export function callDepthNow() {
  return getRuntimeContext().callDepth.depth;
}
