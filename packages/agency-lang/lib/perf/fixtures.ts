/**
 * Synthesized fixtures for the perf suite. Each string generator produces
 * Agency source of controlled size so scaling tests can pick exact N and 8N.
 * Every generator's output MUST parse — a fixture that silently fails to parse
 * makes the thing under test return nothing and the perf number becomes
 * meaningless (fixtures.test.ts pins this).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** n exported functions with small bodies. `docstrings: false` drops the
 *  docstring so every function becomes a missing-docstring finding (AL0002);
 *  `true` (the default) is the clean shape for parse/typecheck/fmt/compile. */
export function manyFunctions(n: number, opts: { docstrings?: boolean } = {}): string {
  const withDoc = opts.docstrings ?? true;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`export def fn${i}(a: number, b: number): number {`);
    if (withDoc) parts.push(`  """Compute a result from a and b for case ${i}."""`);
    parts.push(`  let x = a + b`);
    parts.push(`  let y = x + 1`);
    parts.push(`  return y`);
    parts.push(`}`);
  }
  return `${parts.join("\n")}\n`;
}

/** n unused named imports from distinct modules — a findings-dense input for
 *  the unused-import rule (AL0001). A trivial function keeps the file valid. */
export function manyUnusedImports(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`import { thing${i} } from "./mod${i}.agency"`);
  }
  parts.push(`export def noop(): number { return 1 }`);
  return `${parts.join("\n")}\n`;
}

/** n redundant `import { map } from "std::index"` statements — findings-dense
 *  for the redundant-prelude rule (AL0003), each at a growing offset (the shape
 *  that exposed the locFromOffsets O(n^2)). */
export function manyRedundantPreludeImports(n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    parts.push(`import { map } from "std::index"`);
  }
  parts.push(`export def noop(): number { return 1 }`);
  return `${parts.join("\n")}\n`;
}

/** One function whose body is n-deep nested `if` blocks. Stresses recursive
 *  descent in the parser, generator, and type checker. */
export function deepNesting(n: number): string {
  const lines: string[] = [`export def deep(x: number): number {`];
  for (let i = 0; i < n; i++) {
    lines.push(`${"  ".repeat(i + 1)}if (x > ${i}) {`);
  }
  lines.push(`${"  ".repeat(n + 1)}return x`);
  for (let i = n - 1; i >= 0; i--) {
    lines.push(`${"  ".repeat(i + 1)}}`);
  }
  lines.push(`  return 0`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
}

/** An n-arm string-literal union used by a function. Type checkers commonly go
 *  quadratic on union handling, so this is the typecheck-specific stressor. */
export function wideUnion(n: number): string {
  const arms = Array.from({ length: n }, (_, i) => `"a${i}"`).join(" | ");
  const parts: string[] = [`type Wide = ${arms}`, ``];
  // A handful of functions that take and return the wide union, so the type is
  // resolved at several sites rather than once.
  for (let i = 0; i < 5; i++) {
    parts.push(`export def use${i}(v: Wide): Wide {`);
    parts.push(`  return v`);
    parts.push(`}`);
  }
  return `${parts.join("\n")}\n`;
}

/** One function with n statements — same total size as manyFunctions(n) but a
 *  different shape, to catch per-function-overhead regressions. */
export function oneHugeFunction(n: number): string {
  const lines: string[] = [`export def huge(a: number): number {`, `  let acc = a`];
  for (let i = 0; i < n; i++) {
    lines.push(`  acc = acc + ${i}`);
  }
  lines.push(`  return acc`);
  lines.push(`}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Materializes a temp directory of n interdependent `.agency` files and returns
 * its PATH (not a string) — bundle and the build manifest read files from disk.
 * File i imports a name from file i-1, so the project has a real dependency
 * chain. Caller is responsible for cleanup.
 */
export function multiFileProject(n: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perf-project-"));
  for (let i = 0; i < n; i++) {
    const lines: string[] = [];
    if (i > 0) lines.push(`import { val${i - 1} } from "./file${i - 1}.agency"`);
    const prev = i > 0 ? `val${i - 1}` : "0";
    lines.push(`export const val${i}: number = ${prev} + ${i}`);
    fs.writeFileSync(path.join(dir, `file${i}.agency`), `${lines.join("\n")}\n`, "utf-8");
  }
  return dir;
}
