import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

/**
 * Collects step-coverage hits during Agency execution.
 *
 * Hits are keyed by `${moduleId}:${scopeName}` -> { stepPath: true }.
 *
 * `moduleId` is the source file path relative to cwd (set in
 * `lib/cli/commands.ts` via `path.relative(process.cwd(), absoluteInputFile)`).
 * Modules whose path lives under a `node_modules` directory are intentionally
 * excluded from coverage — they are not user-authored code in this workspace.
 */
export class CoverageCollector {
  private hits: Record<string, Record<string, true>> = {};

  hit(moduleId: string, scopeName: string, stepPath: string): void {
    if (isExternalModule(moduleId)) return;
    const scopeKey = `${moduleId}:${scopeName}`;
    if (!this.hits[scopeKey]) this.hits[scopeKey] = {};
    this.hits[scopeKey][stepPath] = true;
  }

  getHits(): Record<string, Record<string, true>> {
    return this.hits;
  }

  write(outDir: string): void {
    mkdirSync(outDir, { recursive: true });
    const filename = `cov-${process.pid}-${randomUUID()}.json`;
    writeFileSync(join(outDir, filename), JSON.stringify(this.hits));
  }
}

function isExternalModule(moduleId: string): boolean {
  // Normalize Windows backslashes so the check works cross-platform.
  const normalized = moduleId.replace(/\\/g, "/");
  return normalized.includes("/node_modules/") || normalized.startsWith("node_modules/");
}
