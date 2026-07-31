import type { AgencyConfig } from "@/config.js";

import {
  createBuildSession,
  type BuildSession,
  type CompileOptions,
} from "./buildSession.js";

// The default session backing the module-level entry points
// (compile/compileMany/resetCompilationCache). Deliberately the ONLY
// compile-pipeline state in this file: processes are single-session by
// nature, and watch mode resets it between rebuilds. All pipeline logic
// lives in buildSession.ts.
//
// Created LAZILY, not at module top level: `agency pack` bundles compiled
// programs whose import chain reaches small helpers near this module. An
// eager createBuildSession() call is a top-level side effect that defeats
// esbuild tree-shaking and drags the entire codegen subtree into every
// packed artifact (~16k extra lines, caught by pack.test.ts).
let defaultSession: BuildSession | null = null;

function getDefaultSession(): BuildSession {
  return (defaultSession ??= createBuildSession());
}

export function resetCompilationCache(): void {
  defaultSession = null;
}

/**
 * Compile a set of entry files under ONE union closure, like the
 * directory branch of `compile()` does. Callers with many entry points
 * (the test runner's precompile pass) use this instead of per-file
 * `compile()` calls, which would rebuild the closure once per entry.
 *
 * Unlike the CLI directory branch, closure errors THROW
 * (`CompileClosureError`) instead of exiting, so programmatic callers
 * can attach context. Parse/typecheck failures inside per-file
 * `compile()` keep their existing exit behavior.
 */
export function compileMany(
  config: AgencyConfig,
  files: string[],
  options?: {
    quiet?: boolean;
    allowTestImports?: boolean;
  },
): void {
  getDefaultSession().compile(config, { entries: files, ...options });
}

/**
 * Compile an .agency file (or directory of them) to JavaScript. Thin
 * delegate over the default BuildSession — all pipeline logic and caching
 * state live in buildSession.ts.
 */
export function compile(
  config: AgencyConfig,
  inputFile: string,
  _outputFile?: string,
  options?: CompileOptions,
): string | null {
  return getDefaultSession().compile(config, {
    entries: [inputFile],
    outputFile: _outputFile,
    ...options,
  });
}
