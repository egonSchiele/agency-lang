// The runtime's entry point in a browser bundle: "agency-lang/runtime"
// resolves here under the "browser" condition. Everything both platforms
// share is in portable.ts. The generated header also imports a few names
// that Node's entry point takes from Node-only files; each has a stand-in
// here that throws UnsupportedOnHostError when called, or a portable twin.
// lib/runtime/browser.test.ts derives which names need one from
// eslint.node-exceptions.mjs.
export * from "./portable.js";
export { path, os } from "./agencyGlobals.browser.js";

import { UnsupportedOnHostError } from "../host/host.js";

function standIn(name: string, capability: "subprocess" | "terminal" | "fileRead"): never {
  throw new UnsupportedOnHostError({ capability, hostName: "browser", functionName: name });
}

/** Starts a child Agency program; ipc.ts on Node. */
export const _runFor = (): never => standIn("_runFor", "subprocess");
/** Runs a program from the command line; cliEntry.ts on Node. */
export const runCliEntry = (): never => standIn("runCliEntry", "terminal");
/** Asks a person at the terminal about interrupts nothing handled;
 *  cliInterruptResolution.ts on Node. */
export const resolveCliInterrupts = (): never => standIn("resolveCliInterrupts", "terminal");
/** Builds a code literal for a template, which needs the compiler;
 *  template/codeLiteral.ts on Node. */
export const __codeLiteral = (): never => standIn("__codeLiteral", "fileRead");
