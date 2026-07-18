import path from "path";
import { pathToFileURL } from "url";
import type { AgencyFunction } from "../runtime/agencyFunction.js";
import type { InterruptEffect } from "../symbolTable.js";
import { createLogger } from "../logger.js";
import type { Logger } from "../logger.js";
import { discoverExports } from "./discovery.js";
import { createHttpHandler } from "./http/adapter.js";
import type { RouteResult } from "./http/adapter.js";

export type ServeHandler = (
  method: string,
  path: string,
  body: unknown,
) => Promise<RouteResult>;

export type CreateServeHandlerOptions = {
  /** Module id the compiled functions were stamped with (their `fn.module`).
   *  discoverExports filters exported functions by this, so it MUST match the
   *  value used when the module was compiled. */
  moduleId: string;
  /** Names of the exported nodes to serve. */
  exportedNodeNames: string[];
  /** Interrupt effects each function/node may raise, for the /list manifest.
   *  Optional — omitted entries surface as empty arrays. */
  interruptEffectsByName?: Record<string, InterruptEffect[]>;
  /** Cache-bust token (mtime or content hash). Appended to the import URL so a
   *  re-written module at the same path loads new code instead of Node's
   *  cached module. */
  version: string;
  /** Server-side logger for error detail. Defaults to an info logger. */
  logger?: Logger;
};

/**
 * Build the HTTP serve dispatcher for a compiled Agency module. Composes the
 * module import, discoverExports, and createHttpHandler internally so the raw
 * interrupt helpers never cross the package boundary.
 */
export async function createServeHandler(
  compiledPath: string,
  options: CreateServeHandlerOptions,
): Promise<ServeHandler> {
  const {
    moduleId,
    exportedNodeNames,
    interruptEffectsByName = {},
    version,
    logger = createLogger("info"),
  } = options;

  const baseUrl = pathToFileURL(path.resolve(compiledPath)).href;
  const moduleUrl = `${baseUrl}?v=${encodeURIComponent(version)}`;
  // eslint-disable-next-line no-restricted-syntax -- compiled module URL is only known at runtime
  const mod = await import(moduleUrl);
  const moduleExports = mod as Record<string, unknown>;

  const toolRegistry =
    (moduleExports.__toolRegistry as Record<string, AgencyFunction>) ?? {};

  const exports = discoverExports({
    toolRegistry,
    moduleExports,
    moduleId,
    exportedNodeNames,
    interruptEffectsByName,
  });

  return createHttpHandler({
    exports,
    logger,
    // Passed RAW: the HTTP adapter unwraps respondToInterrupts's `{ data }`
    // internally. Do not unwrap here (that is the MCP path's normalization).
    hasInterrupts: moduleExports.hasInterrupts as (data: unknown) => boolean,
    respondToInterrupts: moduleExports.respondToInterrupts as (
      interrupts: unknown[],
      responses: unknown[],
    ) => Promise<unknown>,
  });
}
