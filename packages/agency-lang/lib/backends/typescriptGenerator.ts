import { AgencyProgram } from "../types.js";
import { TypescriptPreprocessor } from "@/preprocessors/typescriptPreprocessor.js";
import { buildCompilationUnit, type CompilationUnit } from "@/compilationUnit.js";
import { AgencyConfig } from "@/config.js";
import { TypeScriptBuilder } from "./typescriptBuilder.js";
import { printTs } from "../ir/prettyPrint.js";
import type { CompiledClosure } from "@/compiler/compileClosure.js";

/**
 * Per-module initialization-plan view derived from a `CompiledClosure`.
 * Captures everything codegen needs to drive the centralized init for
 * one module without exposing the full closure (which would force the
 * builder to know about the dep graph internals).
 */
export type InitPlanForModule = {
  /** Absolute path of this module — used as the registry key for
   * `__registerStaticInit` / `__awaitStaticInit`. MUST match the
   * `sourceModuleId` field of any other module's `awaitModules` entry
   * that references this one, hence absolute (cwd-relative paths
   * would diverge between register and await sites). */
  registryModuleId: string;
  staticLocalOrder: string[];
  staticAwaitModules: { localImport: string; sourceModuleId: string }[];
  globalLocalOrder: string[];
  globalAwaitModules: { localImport: string; sourceModuleId: string }[];
  resolveImportedName: (
    localName: string,
  ) => { sourceModuleId: string; sourceName: string } | null;
};

/**
 * Project a `CompiledClosure` to a single module's per-module init view.
 * Used by both compile entry points (`lib/cli/commands.ts` and
 * `lib/compiler/compile.ts`) — they each build the closure once at the
 * outer call, then call this helper for every per-file `generateTypeScript`.
 */
export function initPlanForModule(
  closure: CompiledClosure,
  moduleId: string,
): InitPlanForModule {
  const plan = closure.plans[moduleId];
  return {
    registryModuleId: moduleId,
    staticLocalOrder: plan?.static.localOrder ?? [],
    staticAwaitModules: (plan?.static.awaitModules ?? []).map((m) => ({
      // `localImport` is currently unused at codegen time — the runtime
      // lookup keys off `sourceModuleId` directly — but we keep the
      // field for future use (e.g., emitting `export ... from` aliases
      // in the centralized-init successor work).
      localImport: m,
      sourceModuleId: m,
    })),
    globalLocalOrder: plan?.global.localOrder ?? [],
    globalAwaitModules: (plan?.global.awaitModules ?? []).map((m) => ({
      localImport: m,
      sourceModuleId: m,
    })),
    resolveImportedName: (localName) =>
      closure.resolver.resolve(localName, moduleId),
  };
}

export function generateTypeScript(
  program: AgencyProgram,
  config?: AgencyConfig,
  info?: CompilationUnit,
  moduleId?: string,
  outputFile?: string,
  initPlan?: InitPlanForModule,
): string {
  if (!moduleId) {
    throw new Error("moduleId is required for generateTypeScript");
  }
  const compilationUnit = info ?? buildCompilationUnit(program);
  const preprocessor = new TypescriptPreprocessor(program, config, compilationUnit);
  const preprocessedProgram = preprocessor.preprocess();
  const builder = new TypeScriptBuilder(config, compilationUnit, moduleId, outputFile, initPlan);
  const ir = builder.build(preprocessedProgram);
  return printTs(ir);
}
