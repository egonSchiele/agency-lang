// The public surface a host app imports to serve compiled Agency modules:
//   import { createServeHandler, collectServeMetadata } from "agency-lang/serve";
export { createServeHandler } from "./createServeHandler.js";
export type { ServeHandler, CreateServeHandlerOptions } from "./createServeHandler.js";
export { collectServeMetadata } from "./metadata.js";
export type { ServeMetadata } from "./metadata.js";
export type { RouteResult, HandlerConfig } from "./http/adapter.js";
export type { ExportedItem, ExportedFunction, ExportedNode } from "./types.js";
export type { InterruptEffect } from "../symbolTable.js";
export type { Logger } from "../logger.js";
