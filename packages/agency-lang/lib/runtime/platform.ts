// The types the two "#platform" files share (platform.node.ts and
// platform.browser.ts).

import type { Host } from "../host/host.js";
import type { AttachFunctions } from "./attachedDebugger.js";
import type { RuntimeContext } from "./state/context.js";
import type { GraphState } from "./types.js";

/** The one field of StatelogClient provider loading needs. Structural so
 *  the runtime bootstrap can pass its client without this file importing
 *  the statelog module. */
export type LocalModelEventSink = {
  localModelLoaded(args: {
    model?: string;
    entryPath?: string;
    entrySource: string;
  }): Promise<void>;
};

/** What `runNode` hands `registerAttach`: the context, the node, the host
 *  the run uses, and the four driver functions bound by the runtime that
 *  owns the context (see `attachFunctionsFor`). */
export type RegisterAttachArgs = {
  ctx: RuntimeContext<GraphState>;
  nodeName: string;
  host: Host;
  functions: AttachFunctions;
};

/** What provider loading reads from the execution context. */
export type ProviderLoadingContext = {
  providerModules?: string[];
  smoltalkDefaults?: { provider?: string; model?: string };
  statelogClient?: LocalModelEventSink;
};
