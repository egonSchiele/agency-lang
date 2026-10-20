import { SourceMap } from "@/backends/sourceMap.js";
import {
  Checkpoint,
  type SourceLocationOpts,
  type ThreadMessages,
  type ThreadSummary,
} from "../runtime/state/checkpointStore.js";
import type { DebugStopData } from "../runtime/debugger.js";
import { statementStepPath } from "../runtime/promptRunner.js";
import { GlobalStore } from "../runtime/state/globalStore.js";
import { checkpointSchema } from "../runtime/state/schemas.js";
import { getStdlibDir } from "../importPaths.js";
import { color } from "@/utils/termcolors.js";
import { uniq } from "@/utils.js";
import fs from "fs";
import path from "path";

export type ValWithOverride = {
  key: string;
  value: unknown;
  override?: unknown;
};

export class UIState {
  private callStack: { functionName: string; moduleId: string; line: number }[];
  private activityLog: string[];
  private pendingOverrides: Record<string, unknown>;
  private mode: "stepping" | "running";
  private checkpoint?: Checkpoint;
  /** Where the program is stopped: the stop's location when the driver
   *  gave one, else the checkpoint's own. Names the frame whose locals
   *  are shown and the source line that is highlighted. */
  private location?: SourceLocationOpts;
  private sourceMap?: SourceMap;
  private currentLine?: number;
  private args: ValWithOverride[] = [];
  private locals: ValWithOverride[] = [];
  private globals: ValWithOverride[] = [];
  private stdoutContent: string[] = [];
  private sourceMapCache: Record<string, SourceMap> = {};

  constructor() {
    this.callStack = [];
    this.activityLog = [];
    this.pendingOverrides = {};
    this.mode = "stepping";
    this.checkpoint = undefined;
    this.args = [];
    this.locals = [];
    this.globals = [];
  }

  static fromCheckpoint(checkpoint: Checkpoint | undefined): UIState {
    const uiState = new UIState();
    uiState.setCheckpoint(checkpoint);
    return uiState;
  }

  /**
   * Resolve a moduleId (e.g., "stdlib/index.agency") to an actual file path,
   * trying the given extensions. Handles stdlib modules that live inside
   * node_modules/agency-lang/stdlib/ when running from an external project.
   */
  resolveModulePath(moduleId: string, extensions: string[]): string | null {
    // Try the path as-is first (works when running from the agency-lang repo)
    for (const ext of extensions) {
      const candidate = moduleId.replace(/\.agency$/, ext);
      if (fs.existsSync(candidate)) return candidate;
    }

    // If the moduleId refers to a stdlib file, resolve against the actual
    // stdlib directory (handles npm-installed packages where stdlib lives
    // in node_modules/agency-lang/stdlib/)
    const stdlibMatch = moduleId.match(/(?:^|[/\\])stdlib[/\\](.+)$/);
    if (stdlibMatch) {
      const stdlibRelativePath = stdlibMatch[1];
      for (const ext of extensions) {
        const candidate = path.join(getStdlibDir(), stdlibRelativePath).replace(/\.agency$/, ext);
        if (fs.existsSync(candidate)) return candidate;
      }
    }

    return null;
  }

  private agencyToJsFile(agencyFile: string): string | null {
    return this.resolveModulePath(agencyFile, [".js", ".ts"]);
  }

  async setCheckpoint(checkpoint: Checkpoint | undefined, stop?: DebugStopData) {
    const cp = Checkpoint.fromJSON(checkpoint);
    if (!cp) {
      this.log("Invalid checkpoint provided, cannot set checkpoint");
      return;
    }
    this.checkpoint = cp;
    // A checkpoint stamped by the tool loop, at one of its own stops or
    // on an interrupt it carried out of a request or a tool, is located
    // under the `llm()` statement: its step path is the statement's
    // path, a slash, and the loop's key. The source pane shows the
    // statement. At the loop's own stops the frame is the caller's.
    const location = stop ?? cp.location;
    this.location = { ...location, stepPath: statementStepPath(location.stepPath) };
    const branchPath = this.location.branchPath ?? [];
    const frame = cp.shownFrame(location);
    if (!frame) {
      this.log("No current frame available in checkpoint");
      return;
    }
    this.args = [];
    this.locals = [];

    this.setWithOverrides(frame.args, this.args);
    this.setWithOverrides(frame.locals, this.locals);
    const globalsForModule = cp.globalsAt(branchPath).store?.[this.location.moduleId] ?? null;
    if (globalsForModule) {
      this.setWithOverrides(globalsForModule, this.globals);
    }
    await this.setSourceMap();
  }

  setWithOverrides(obj: Record<string, unknown>, array: ValWithOverride[]) {
    for (const key in obj) {
      if (this.isInternalVar(key)) {
        continue;
      }
      array.push({
        key,
        value: obj[key],
        override: this.pendingOverrides[key],
      });
    }
  }

  log(message: string) {
    this.activityLog.push(message);
  }

  async setSourceMap() {
    if (!this.checkpoint || !this.location) {
      this.log("No checkpoint set, cannot determine source map");
      return;
    }
    const location = this.location;
    const moduleId = location.moduleId;

    if (this.sourceMapCache[moduleId]) {
      this.sourceMap = this.sourceMapCache[moduleId];
    } else {
      const jsFile = this.agencyToJsFile(moduleId);
      if (!jsFile) {
        this.log(`Could not find compiled JS file for module ${moduleId}`);
        return;
      }
      // Dynamically import the compiled module
      const absOutput = path.resolve(jsFile);
      // eslint-disable-next-line no-restricted-syntax -- compiled module path is only known at runtime
      const mod = await import(absOutput);
      if (!mod) {
        this.log(`Could not import module ${absOutput} for checkpoint`);
        return;
      }
      if (!mod.__sourceMap) {
        this.log(`No source map found in module ${absOutput}`);
        return;
      }
      this.sourceMap = mod.__sourceMap ?? {};
      if (!this.sourceMap) {
        this.log(`Source map is undefined in module ${absOutput}`);
        return;
      }
      this.sourceMapCache[moduleId] = this.sourceMap;
    }
    // Look up source location from the source map
    const scopeKey = `${location.moduleId}:${location.scopeName}`;
    const scopeMap = this.sourceMap?.[scopeKey];
    if (!scopeMap) {
      this.log(`No source map entry found for scope ${scopeKey}, stepPath: ${location.stepPath}`);
      return;
    }
    if (!scopeMap[location.stepPath]) {
      this.log(
        `No source map entry found for step path ${location.stepPath}, scopeKey: ${scopeKey}`,
      );
      return;
    }
    // we actually want to highlight the next line (i.e. the line we're about to execute)
    this.currentLine = scopeMap[location.stepPath].line + 1;
  }

  setMode(mode: "stepping" | "running") {
    this.mode = mode;
  }

  setOverride(key: string, value: unknown) {
    this.pendingOverrides[key] = value;
  }

  /** The threads the stopped code sees, the active one marked. */
  listThreads(): ThreadSummary[] {
    if (!this.checkpoint) return [];
    return this.checkpoint.listThreads(this.location?.branchPath ?? []);
  }

  /** The messages of `threadId`, or of the active thread when none is
   *  named. */
  getThreadMessages(threadId?: string): ThreadMessages | null {
    if (!this.checkpoint) return null;
    return this.checkpoint.getThreadMessages(threadId, this.location?.branchPath ?? []);
  }

  getModuleId() {
    return this.location?.moduleId || "unknown module";
  }

  /** Where the program is stopped, as the panes show it. */
  getLocation(): SourceLocationOpts | undefined {
    return this.location;
  }

  getCurrentLine() {
    if (!this.currentLine) {
      this.log(`Current line not available, module id: ${this.getModuleId()}`);
    }
    return this.currentLine || -1;
  }

  getArgs() {
    return this.filterDupeVals(this.args);
  }

  getLocals() {
    return this.filterDupeVals(this.locals);
  }

  getGlobals() {
    return this.filterDupeVals(this.globals);
  }

  pushCallStackEntry({
    functionName,
    moduleId,
    line,
  }: {
    functionName: string;
    moduleId: string;
    line: number;
  }) {
    this.callStack.push({ functionName, moduleId, line });
  }

  removeWithFuncName(functionName: string) {
    this.callStack = this.callStack.filter((entry) => entry.functionName !== functionName);
  }

  getCallStack() {
    return this.callStack;
  }

  resetCallStack() {
    this.callStack = [];
  }

  getOverrides() {
    return this.pendingOverrides;
  }

  resetOverrides() {
    this.pendingOverrides = {};
  }

  getActivityLog() {
    return this.activityLog;
  }

  stepping() {
    this.mode = "stepping";
  }

  addToStdout(text: string) {
    this.stdoutContent.push(text);
  }

  getStdout() {
    return this.stdoutContent;
  }

  getTokenStats(): { totalTokens: number; totalCost: number } {
    if (!this.checkpoint?.globals) return { totalTokens: 0, totalCost: 0 };
    return GlobalStore.tokenStatsFromJSON(this.checkpoint.globals);
  }

  toJSON() {
    return {
      callStack: this.callStack,
      activityLog: this.activityLog,
      pendingOverrides: this.pendingOverrides,
      mode: this.mode,
      checkpoint: this.checkpoint ? this.checkpoint.toJSON() : undefined,
      args: this.args,
      locals: this.locals,
      globals: this.globals,
      stdoutContent: this.stdoutContent,
    };
  }

  static fromJSON(json: any): UIState {
    const uiState = new UIState();
    uiState.callStack = json.callStack;
    uiState.activityLog = json.activityLog;
    uiState.pendingOverrides = json.pendingOverrides;
    uiState.mode = json.mode;
    const cp = json.checkpoint ? Checkpoint.fromJSON(json.checkpoint) : null;
    if (!cp) {
      uiState.log("Invalid checkpoint provided, cannot set checkpoint");
    }
    uiState.checkpoint = cp || undefined;
    uiState.args = json.args;
    uiState.locals = json.locals;
    uiState.globals = json.globals;
    uiState.stdoutContent = json.stdoutContent;
    return uiState;
  }

  clone(): UIState {
    return UIState.fromJSON(this.toJSON());
  }

  private isInternalVar(key: string): boolean {
    return key.startsWith("__");
  }

  private filterDupeVals(vals: ValWithOverride[]): ValWithOverride[] {
    const seenKeys = new Set<string>();
    const result: ValWithOverride[] = [];
    for (const val of vals) {
      if (!seenKeys.has(val.key)) {
        seenKeys.add(val.key);
        result.push(val);
      }
    }
    return result;
  }
}
