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
    const visited = new Set<string>();
    for (const imp of imports) {
      if (!imp.startsWith("./") && !imp.startsWith("../")) continue;
      if (!imp.endsWith(".js")) continue;

      const resolved = path.resolve(path.dirname(sourceFile), imp);
      this.ensureJsExists(resolved, sourceFile, visited);
    }
  }

  private ensureJsExists(jsPath: string, importer: string, visited: Set<string>): void {
    const normalized = path.normalize(jsPath);
    if (visited.has(normalized)) return;
    visited.add(normalized);

    if (fs.existsSync(normalized)) return;

    const tsPath = normalized.replace(/\.js$/, ".ts");
    if (!fs.existsSync(tsPath)) {
      throw new Error(
        `Cannot resolve import '${path.relative(path.dirname(importer), normalized)}' from '${importer}'.\n` +
        `Tried: ${normalized}, ${tsPath} — neither file exists.`,
      );
    }

    // Recursively ensure this file's dependencies exist first
    const tsCode = fs.readFileSync(tsPath, "utf-8");
    for (const nestedImp of this.getLocalJsImports(tsCode)) {
      const nestedResolved = path.resolve(path.dirname(tsPath), nestedImp);
      this.ensureJsExists(nestedResolved, tsPath, visited);
    }

    // Then compile this file
    const result = transformSync(tsCode, {
      loader: "ts",
      format: "esm",
      supported: { "top-level-await": true },
    });
    fs.writeFileSync(normalized, result.code);
  }

  /** Extract relative .js imports from TypeScript source code. */
  private getLocalJsImports(code: string): string[] {
    const imports: string[] = [];
    const pattern = /\bimport\s+(?:[^'"]+?\s+from\s+)?["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(code)) !== null) {
      const specifier = match[1];
      if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
        imports.push(specifier);
      }
    }
    return imports;
  }
}
