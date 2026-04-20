import * as fs from "fs";
import * as path from "path";
import { transformSync } from "esbuild";

export type CompileOptions = {
  /** Extension for .agency rewrites: ".js" or ".ts" */
  targetExt: ".js" | ".ts";
};

export interface ImportStrategy {
  /**
   * Rewrite an import path for the output.
   * Handles .agency, .js, and .ts imports.
   */
  rewriteImport(modulePath: string, sourceFile: string): string;

  /**
   * Ensure all non-Agency dependencies are available for execution.
   * Called after compilation, before the output is executed.
   * Errors if a dependency can't be resolved.
   */
  prepareDependencies(imports: string[], sourceFile: string): void;
}

/**
 * Strategy for `agency compile`: produces output for a downstream build pipeline.
 * Leaves .js/.ts imports untouched. Only rewrites .agency imports.
 */
export class CompileStrategy implements ImportStrategy {
  constructor(protected options: CompileOptions) {}

  rewriteImport(modulePath: string, _sourceFile: string): string {
    if (modulePath.endsWith(".agency")) {
      return modulePath.replace(/\.agency$/, this.options.targetExt);
    }
    return modulePath;
  }

  prepareDependencies(_imports: string[], _sourceFile: string): void {
    // No-op — user's build pipeline handles dependencies
  }
}

/**
 * Strategy for `agency run` / `agency debug` / `agency test`: compiles and
 * immediately executes. All imports must resolve to .js files that exist on disk.
 * Compiles .ts dependencies to .js via esbuild when needed.
 */
export class RunStrategy extends CompileStrategy {
  constructor() {
    super({ targetExt: ".js" });
  }

  rewriteImport(modulePath: string, sourceFile: string): string {
    if (modulePath.endsWith(".agency")) {
      return super.rewriteImport(modulePath, sourceFile);
    }
    // Always produce .js — Node needs .js at runtime
    return modulePath.replace(/\.ts$/, ".js");
  }

  prepareDependencies(imports: string[], sourceFile: string): void {
    for (const imp of imports) {
      if (!imp.startsWith("./") && !imp.startsWith("../")) continue;
      if (!imp.endsWith(".js")) continue;

      const resolved = path.resolve(path.dirname(sourceFile), imp);
      if (fs.existsSync(resolved)) continue;

      const tsPath = resolved.replace(/\.js$/, ".ts");
      if (fs.existsSync(tsPath)) {
        const tsCode = fs.readFileSync(tsPath, "utf-8");
        const result = transformSync(tsCode, {
          loader: "ts",
          format: "esm",
          supported: { "top-level-await": true },
        });
        fs.writeFileSync(resolved, result.code);
      } else {
        throw new Error(
          `Cannot resolve import '${imp}' from '${sourceFile}'.\n` +
          `Tried: ${resolved}, ${tsPath} — neither file exists.`,
        );
      }
    }
  }
}
