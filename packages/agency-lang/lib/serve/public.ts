// The public surface a host app imports to serve compiled Agency modules:
//   import { createServeHandler, collectServeMetadata } from "agency-lang/serve";
export { createServeHandler } from "./createServeHandler.js";
export type { ServeHandler, CreateServeHandlerOptions } from "./createServeHandler.js";
export { collectServeMetadata } from "./metadata.js";
export type { ServeMetadata } from "./metadata.js";
// Bind per-module log/observability config at import time (see the helper's
// doc comment): a host serving many compiled modules from one process wraps
// each module's import in this so that module traces to its own destination.
export { withRuntimeConfigOverrides } from "../runtime/configOverrides.js";
export type { RouteResult, HandlerConfig } from "./http/adapter.js";
// The per-invocation options a host attaches to a single call (4th arg of a
// ServeHandler). The internal resolver/resolved types stay runtime-private.
export type { InvocationOptions } from "../runtime/invocationOptions.js";
export type { ExportedItem, ExportedFunction, ExportedNode } from "./types.js";
export type { InterruptEffect } from "../symbolTable.js";
export type { Logger } from "../logger.js";
