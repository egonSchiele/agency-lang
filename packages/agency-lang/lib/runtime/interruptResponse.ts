// Interrupt response constructors and their types, in a dependency-free leaf.
//
// Both the runtime interrupt machinery (`interrupts.ts`) and the CLI-side
// resolver (`interruptResolution.ts`, `runPolicyHandler.ts`) need these. Keeping
// them here — importing nothing from the runtime — lets those modules share the
// response API without forming an import cycle. `interrupts.ts` re-exports these
// names, so existing `import { approve, reject } from "./interrupts.js"` keeps
// working.

/** Who made a handler's decision, when the handler knows. The runtime only
 * sees handler functions; a handler that consults a policy file or asks a
 * person at a terminal tags its verdict so the statelog can say "policy" or
 * "user" instead of the uninformative "handler". */
export type DecisionSource = "policy" | "user";

export type InterruptApprove = { type: "approve"; value?: any; decidedBy?: DecisionSource };
export type InterruptReject = { type: "reject"; value?: any; decidedBy?: DecisionSource };
export type InterruptResponse = InterruptApprove | InterruptReject;

export function approve(value?: any): InterruptResponse {
  return { type: "approve", value };
}

export function reject(value?: any): InterruptResponse {
  return { type: "reject", value };
}
