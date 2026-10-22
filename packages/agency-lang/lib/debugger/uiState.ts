import { SourceMap } from "@/backends/sourceMap.js";
import {
  Checkpoint,
  frameName,
  type SourceLocationOpts,
  type ThreadMessages,
  type BranchSummary,
  type GuardSummary,
  type LoopState,
  type ThreadSummary,
} from "../runtime/state/checkpointStore.js";
import type { BusyEntry, DebugStopData, StopLocation } from "../runtime/debugger.js";
import { withSince, type BusyShown } from "./busy.js";
import { statementStepPath } from "../runtime/promptRunner.js";
import { GlobalStore } from "../runtime/state/globalStore.js";
import type { LoopStopKind } from "../runtime/state/sourceLocation.js";
import type { PendingPreview } from "./edits/rows.js";
import type { StateJSON } from "../runtime/state/stateStack.js";
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
  private activityLog: string[];
  private pending: PendingPreview;
  private mode: "stepping" | "running";
  private checkpoint?: Checkpoint;
  /** Where the program is stopped: the stop's location when the driver
   *  gave one, else the checkpoint's own. Names the frame whose locals
   *  are shown and the source line that is highlighted. */
  private location?: SourceLocationOpts;
  /** The stop's own location, kept while a branch is being viewed. */
  private stopLocation?: SourceLocationOpts;
  /** The stop record the driver passed, when the stop is a debug stop. */
  private stop?: DebugStopData;
  /** The module whose globals the globals pane shows: the viewed
   *  frame's. The source pane shows `location.moduleId`, the stop's. */
  private globalsModuleId?: string;
  private sourceMap?: SourceMap;
  private currentLine?: number;
  private args: ValWithOverride[] = [];
  private locals: ValWithOverride[] = [];
  private globals: ValWithOverride[] = [];
  private stdoutContent: string[] = [];
  private sourceMapCache: Record<string, SourceMap> = {};
  /** What the program is waiting on, as the run last reported it, each
   *  with the time this UI first saw it. */
  private busy: BusyShown[] = [];

  constructor() {
    this.activityLog = [];
    this.pending = { edits: [], applied: [] };
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

  /** Show `checkpoint`, at `stop` when the driver has a stop record, else
   *  at the checkpoint's own location. `interruptId` is the user interrupt
   *  the checkpoint was taken for, when there is one: an interrupt raised
   *  inside a tool, a fork, or a parallel arm is stamped on the shared
   *  checkpoint at the join, whose location has no branch path, so the
   *  branch is found by the interrupt's id. */
  async setCheckpoint(
    checkpoint: Checkpoint | undefined,
    stop?: DebugStopData,
    interruptId?: string,
  ) {
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
    this.stop = stop;
    // A user interrupt raised inside a tool, a fork, or a parallel arm is
    // stamped on the shared checkpoint at the join, whose location has no
    // branch path; the branch is found by the interrupt's id.
    const branchPath =
      location.branchPath ??
      (interruptId === undefined ? undefined : cp.branchPathOf(interruptId)) ??
      [];
    this.stopLocation = { ...location, branchPath, stepPath: statementStepPath(location.stepPath) };
    this.location = this.stopLocation;
    if (!this.showFrame(this.stopLocation, location.moduleId)) return;
    await this.setSourceMap();
  }

  /** Fill the args and locals panes from the frame at `location`, and
   *  the globals pane from `moduleId`'s globals as that frame's stack
   *  sees them. False when the checkpoint has no such frame. */
  private showFrame(
    location: { branchPath?: string[]; loopStop?: LoopStopKind },
    moduleId: string,
  ): boolean {
    const cp = this.checkpoint!;
    const frame = cp.shownFrame(location);
    if (!frame) {
      this.log("No current frame available in checkpoint");
      return false;
    }
    this.args = [];
    this.locals = [];
    this.globals = [];
    this.globalsModuleId = moduleId;
    this.setWithOverrides(frame.args, this.args);
    this.setWithOverrides(frame.locals, this.locals);
    const globalsForModule = cp.globalsAt(location.branchPath ?? []).store?.[moduleId] ?? null;
    if (globalsForModule) {
      this.setWithOverrides(globalsForModule, this.globals);
    }
    return true;
  }

  /** Look at a branch's stack: the locals and globals panes show its
   *  last frame, and the source pane keeps the stop's line and module.
   *  An empty path returns to the stop. */
  viewBranch(path: string[]): void {
    if (!this.checkpoint || !this.stopLocation) return;
    if (path.length === 0) {
      this.location = this.stopLocation;
      this.showFrame(this.stopLocation, this.stopLocation.moduleId);
      return;
    }
    const frame = this.checkpoint.frameAt(path);
    if (!frame) {
      this.log(`No branch at ${path.join("/")}`);
      return;
    }
    this.location = { ...this.stopLocation, branchPath: path, loopStop: undefined };
    this.showFrame(this.location, frame.moduleId ?? this.stopLocation.moduleId);
  }

  /** The value of a variable as the panes show it: an argument or a
   *  local of the viewed frame, else a global of the viewed module. */
  lookupVariable(name: string): unknown {
    const entry = [...this.args, ...this.locals, ...this.globals].find((e) => e.key === name);
    return entry?.value;
  }

  /** Every branch in the checkpoint; see `Checkpoint.listBranches`. */
  listBranches(): BranchSummary[] {
    return this.checkpoint?.listBranches() ?? [];
  }

  /** The guards the stopped code runs under, outermost first. */
  listGuards(): GuardSummary[] {
    return this.checkpoint?.listGuards(this.location?.branchPath ?? []) ?? [];
  }

  /** The tool loop the stopped code is in, or null. The loop counts a
   *  round when its request returns, so at the loop's own stop before a
   *  request the stop's label, `round N`, is the round the person sees. */
  loopState(): LoopState | null {
    const branchPath = this.location?.branchPath ?? [];
    const state = this.checkpoint?.loopState(branchPath) ?? null;
    if (!state) return null;
    const atStop = branchPath.join("/") === (this.stop?.branchPath ?? []).join("/");
    const labelled =
      this.stop?.loopStop === "round" ? this.stop.label?.match(/^round (\d+)$/) : null;
    if (atStop && labelled) return { ...state, round: Number(labelled[1]) };
    return state;
  }

  setWithOverrides(obj: Record<string, unknown>, array: ValWithOverride[]) {
    for (const key in obj) {
      if (this.isInternalVar(key)) {
        continue;
      }
      array.push({
        key,
        value: obj[key],
        override: this.pendingValue(key),
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

    if (!(await this.loadSourceMap(moduleId))) {
      return;
    }
    this.sourceMap = this.sourceMapCache[moduleId];
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

  /** Replace the queued edits with the driver's copy. */
  setPending(preview: PendingPreview) {
    this.pending = { edits: [...preview.edits], applied: [...preview.applied] };
  }

  getPending(): PendingPreview {
    return this.pending;
  }

  /** The value a pending `setLocal` or `setArg` gives `name` on the
   *  shown frame, or undefined when none does. */
  private pendingValue(name: string): unknown {
    const edit = this.pending.edits.findLast(
      (candidate) =>
        (candidate.op === "setLocal" || candidate.op === "setArg") && candidate.name === name,
    );
    return edit === undefined ? undefined : (edit as { value: unknown }).value;
  }

  /** Replace the list of open waits with the run's latest, keeping the
   *  time each one was first seen (`withSince`). */
  setBusy(entries: BusyEntry[], now: number = Date.now()) {
    this.busy = withSince(this.busy, entries, now);
  }

  /** The open waits, the one that began last at the end. */
  getBusy(): BusyShown[] {
    return this.busy;
  }

  /** The source line of a stop's or a wait's location, from the source
   *  map of its module when that map has been loaded (`loadSourceMap`);
   *  undefined when it has not, or has no entry for the step. */
  lineFor(location: StopLocation): number | undefined {
    const scopeMap =
      this.sourceMapCache[location.moduleId]?.[`${location.moduleId}:${location.scopeName}`];
    const entry = scopeMap?.[statementStepPath(location.stepPath)];
    // The line the map records is the one before the statement runs.
    return entry === undefined ? undefined : entry.line + 1;
  }

  /** Whether the module's source map is loaded. */
  hasSourceMap(moduleId: string): boolean {
    return this.sourceMapCache[moduleId] !== undefined;
  }

  /** Load `moduleId`'s source map into the cache from its compiled
   *  module; false, with a line in the log, when it cannot be. */
  async loadSourceMap(moduleId: string): Promise<boolean> {
    if (this.sourceMapCache[moduleId]) {
      return true;
    }
    const jsFile = this.agencyToJsFile(moduleId);
    if (!jsFile) {
      this.log(`Could not find compiled JS file for module ${moduleId}`);
      return false;
    }
    // Dynamically import the compiled module. Attached, this runs in the
    // debugger's process, where the program's dependencies may not load;
    // a failure costs the source pane its line, not the debugger.
    const absOutput = path.resolve(jsFile);
    let mod: { __sourceMap?: SourceMap } | undefined;
    try {
      // eslint-disable-next-line no-restricted-syntax -- compiled module path is only known at runtime
      mod = await import(absOutput);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Could not load module ${absOutput} for its source map: ${message}`);
      return false;
    }
    if (!mod) {
      this.log(`Could not import module ${absOutput} for checkpoint`);
      return false;
    }
    if (!mod.__sourceMap) {
      this.log(`No source map found in module ${absOutput}`);
      return false;
    }
    this.sourceMapCache[moduleId] = mod.__sourceMap;
    return true;
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

  /** The module the source pane shows: the stop's, or, before any stop
   *  while the program runs, the one it is waiting in. */
  getModuleId() {
    return this.location?.moduleId || this.busy.at(-1)?.entry.location.moduleId || "unknown module";
  }

  /** The module the globals pane shows: the viewed frame's, which after
   *  `b` can differ from the source pane's. */
  getGlobalsModuleId() {
    return this.globalsModuleId ?? this.getModuleId();
  }

  /** Where the program is stopped, as the panes show it. */
  getLocation(): SourceLocationOpts | undefined {
    return this.location;
  }

  /** The stop's line, or -1 before a stop or when the map has no entry
   *  for it; `setSourceMap` logs the reason once, so a redraw does not. */
  getCurrentLine() {
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

  /** The call stack, read from the checkpoint's frames: one entry per
   *  frame from the root stack down to the stack the program is stopped
   *  on, the stopped frame last. The tool loop's own frame is shown as
   *  `llm()`, and the compiler-named frame of a fork or parallel arm or
   *  a block argument as `block`. Only Agency code and the TypeScript
   *  that claims a resumable scope have frames; other TypeScript
   *  functions do not appear. */
  getCallStack(): { functionName: string; moduleId: string }[] {
    if (!this.checkpoint) return [];
    return this.checkpoint.framesAlong(this.location?.branchPath ?? []).map((frame) => ({
      functionName: frameName(frame.scopeName),
      moduleId: frame.moduleId ?? "",
    }));
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
      activityLog: this.activityLog,
      pending: this.pending,
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
    uiState.activityLog = json.activityLog;
    uiState.pending = json.pending ?? { edits: [], applied: [] };
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
    const copy = UIState.fromJSON(this.toJSON());
    // What the program is waiting on is the run's, not the checkpoint's,
    // and an overlay drawn from a copy shows it too.
    copy.busy = this.busy;
    copy.sourceMapCache = this.sourceMapCache;
    return copy;
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
