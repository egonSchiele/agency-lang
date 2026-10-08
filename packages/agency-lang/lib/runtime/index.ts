// The runtime's entry point on Node: "agency-lang/runtime" resolves here by
// default, and to browser.ts under the "browser" condition. Everything both
// platforms share is in portable.ts; the names below come from Node-only
// files (eslint.node-exceptions.mjs), and browser.ts exports a stand-in or
// a portable twin for each one the generated header imports.
export * from "./portable.js";

export { nodeHost } from "../host/node/nodeHost.js";
export type { NodeHostOptions } from "../host/node/nodeHost.js";
// Agency code may call `path.join` and `os.homedir()` as free names; the
// generated header imports them from here, so it imports no Node module.
// On Node they are Node's own modules.
export { path, os } from "./agencyGlobals.node.js";
export { __codeLiteral } from "./template/codeLiteral.js";
export { TraceReader } from "./trace/traceReader.js";
export { resolveCliInterrupts } from "./cliInterruptResolution.js";
export { runCliEntry } from "./cliEntry.js";
export { _run, _runFor } from "./ipc.js";
export { DebuggerState } from "../debugger/debuggerState.js";
export { CoverageCollector } from "./coverageCollector.js";
