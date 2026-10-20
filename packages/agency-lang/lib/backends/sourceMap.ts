import type { SourceLocation } from "../types/base.js";

export type SourceMapLocation = { line: number; col: number };
export type SourceMap = Record<string, Record<string, SourceMapLocation>>;

export class SourceMapBuilder {
  private currentKey: string = "";
  /** How many leading ids of the builder's step path belong to the scopes
   *  above the current one. A block helper (a fork body, a block argument)
   *  runs under a runner of its own, whose step paths start at 0, so its
   *  records drop the path of the statement that holds the block: the
   *  first statement of a fork body at builder path `[2, 0]` is step `0`
   *  at run time. */
  private base: number = 0;
  private enclosing: Array<{ key: string; base: number }> = [];
  private map: SourceMap = {};

  /** Enter a function or node scope, whose step paths start at the root. */
  enterScope(moduleId: string, scopeName: string): void {
    this.currentKey = `${moduleId}:${scopeName}`;
    this.base = 0;
    if (!this.map[this.currentKey]) {
      this.map[this.currentKey] = {};
    }
  }

  /** Enter a block scope inside the current one. `base` is the length of
   *  the builder's step path at the block, the part its records drop. */
  enterBlockScope(moduleId: string, scopeName: string, base: number): void {
    this.enclosing.push({ key: this.currentKey, base: this.base });
    this.enterScope(moduleId, scopeName);
    this.base = base;
  }

  /** Return to the scope that holds the block. */
  exitBlockScope(): void {
    const outer = this.enclosing.pop();
    if (!outer) {
      throw new Error("SourceMapBuilder: exitBlockScope() called outside a block scope");
    }
    this.currentKey = outer.key;
    this.base = outer.base;
  }

  record(subStepPath: number[], loc: SourceLocation | undefined): void {
    if (!loc || !this.currentKey) return;
    const stepPath = subStepPath.slice(this.base).join(".");
    this.map[this.currentKey][stepPath] = { line: loc.line, col: loc.col };
  }

  build(): SourceMap {
    return structuredClone(this.map);
  }
}
