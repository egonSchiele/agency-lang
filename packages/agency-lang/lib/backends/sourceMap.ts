import type { SourceLocation } from "../types/base.js";

export type SourceMapLocation = { line: number; col: number };
export type SourceMap = Record<string, Record<string, SourceMapLocation>>;

export class SourceMapBuilder {
  private currentKey: string = "";
  private map: SourceMap = {};

  enterScope(moduleId: string, scopeName: string): void {
    this.currentKey = `${moduleId}:${scopeName}`;
    if (!this.map[this.currentKey]) {
      this.map[this.currentKey] = {};
    }
  }

  record(subStepPath: number[], loc: SourceLocation | undefined): void {
    if (!loc || !this.currentKey) return;
    this.map[this.currentKey][subStepPath.join(".")] = { line: loc.line, col: loc.col };
  }

  build(): SourceMap {
    return structuredClone(this.map);
  }
}
