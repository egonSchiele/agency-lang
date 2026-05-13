import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

/**
 * Collects step-coverage hits during Agency execution.
 *
 * Hits are keyed by `${moduleId}:${scopeName}` -> { stepPath: true }.
 *
 * Modules imported from npm packages (`pkg::` prefix or paths under
 * `node_modules`) are intentionally excluded from coverage. They are not
 * user-authored code in this workspace.
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
  if (moduleId.startsWith("pkg::")) return true;
  if (moduleId.includes("/node_modules/")) return true;
  return false;
}
