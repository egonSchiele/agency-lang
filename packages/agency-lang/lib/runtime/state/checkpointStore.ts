import { MessageJSON } from "smoltalk";
import { signCheckpoint } from "../checkpointChecksum.js";
import type { HostSettings } from "../../host/host.js";
import { CheckpointError } from "../errors.js";
import { collectModuleFingerprints } from "../referencedModules.js";
import type { ModuleFingerprint } from "../moduleFingerprintRegistry.js";
import { deepClone } from "../utils.js";
import type { RuntimeContext } from "./context.js";
import type { GlobalStoreJSON } from "./globalStore.js";
import { checkpointSchema } from "./schemas.js";
import type { LoopStopKind, SourceLocation } from "./sourceLocation.js";
import { isIntrinsicToolName } from "../intrinsicTools.js";
import { isBlockName } from "../blockNames.js";
import type { BranchStateJSON, StateJSON, StateStackJSON } from "./stateStack.js";
import type { MessageThreadJSON } from "./messageThread.js";
import type { StateStack } from "./stateStack.js";
import type { RunUsage } from "../invocationUsage.js";

/** Label used for pinned checkpoints created at function entry for Result error handling. */
export const RESULT_ENTRY_LABEL = "result-entry";

let globalCheckpointCounter = 0;

export type SourceLocationOpts = Omit<SourceLocation, "nodeId">;

/** Whether two locations name the same step on the same stack. A step
 *  inside a tool call is told from the same step in another call of that
 *  tool by its branch path. */
export function sameLocation(a: SourceLocationOpts, b: SourceLocationOpts): boolean {
  const aPath = a.branchPath ?? [];
  const bPath = b.branchPath ?? [];
  return (
    a.moduleId === b.moduleId &&
    a.scopeName === b.scopeName &&
    a.stepPath === b.stepPath &&
    aPath.length === bPath.length &&
    aPath.every((key, index) => key === bPath[index])
  );
}

/** Whether `a`'s step ran on the same stack as `b`'s or on a stack above
 *  it: `a`'s branch path is a prefix of `b`'s. */
function onStackOrAbove(a: SourceLocationOpts, b: SourceLocationOpts): boolean {
  const aPath = a.branchPath ?? [];
  const bPath = b.branchPath ?? [];
  return aPath.length <= bPath.length && aPath.every((key, index) => key === bPath[index]);
}

/** Reset the global checkpoint ID counter. For use in tests only. */
export function resetGlobalCheckpointCounter(): void {
  globalCheckpointCounter = 0;
}

export type ThreadMessages = {
  threadId: string;
  label: string | null;
  threadIndex: number;
  threadCount: number;
  messages: { role: string; content: string }[];
};

/** One branch of a frame, as the branches pane lists it: a tool call, a
 *  fork branch, or a parallel item, with its own stack. */
export type BranchSummary = {
  /** The branch keys from the root down to this branch. */
  path: string[];
  /** Where the branch's record is in the checkpoint's JSON. */
  jsonPath: string[];
  key: string;
  /** The frame that owns the branch; the tool loop's is `llm()`. */
  owner: string;
  /** The scope the branch runs: the tool's name, or the block's. */
  label: string;
  status: "running" | "interrupted" | "done";
};

/** One guard on the stacks the stopped code runs under. */
export type GuardSummary = {
  label: string | null;
  dimension: "cost" | "time";
  /** Dollars, or milliseconds. */
  limit: number;
  spent: number;
  disarmed: boolean;
  root: boolean;
  /** True when the figures are a branch's own copy of a guard above it:
   *  a time guard's clone carries the parent's remaining time as its
   *  limit, and the branch's own working time as spent. */
  inherited: boolean;
  /** Where every copy of the guard is in the checkpoint's JSON, the
   *  owning copy first, then each clone down the branch path. */
  jsonPaths: string[][];
};

/** The tool loop the stopped code is in: its round, counted from 1, the
 *  tools the loop has removed, the tools it was offered (null for a
 *  checkpoint from before the loop recorded them), and where its frame
 *  is in the checkpoint's JSON. */
export type LoopState = {
  round: number;
  removedTools: string[];
  tools: string[] | null;
  jsonPath: string[];
};

/** A frame along a branch path, with where it is in the checkpoint's
 *  JSON, so a reader can say what it found and where. */
export type FrameAt = { frame: StateJSON; jsonPath: string[] };

/** The globals a stack reads and where they are in the JSON. */
export type GlobalsLocation = { store: Record<string, Record<string, any>>; jsonPath: string[] };

/** Which list a message appended to `thread` goes in. A thread whose
 *  last assistant message made tool calls that the messages after it do
 *  not all answer cannot take a user message yet, since providers want
 *  every call answered first; the message is queued and the round
 *  boundary delivers it after the results. Any other thread takes it at
 *  the end. */
export type MessageLike = {
  role?: string;
  content?: unknown;
  toolCalls?: { id?: string; name?: string }[];
  toolCallId?: string;
};

export function messageLanding(thread: { messages: MessageLike[] }): "messages" | "queued" {
  return pendingToolCalls(thread) > 0 ? "queued" : "messages";
}

/** How many calls of the thread's last assistant message have no result
 *  after it yet. */
export function pendingToolCalls(thread: { messages: MessageLike[] }): number {
  const messages = thread.messages;
  const lastCall = messages.findLastIndex(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.length > 0,
  );
  if (lastCall < 0) return 0;
  const answered = messages
    .slice(lastCall + 1)
    .map((m) => m.toolCallId)
    .filter((id): id is string => typeof id === "string");
  const calls = (messages[lastCall].toolCalls ?? []).map((call) => call.id ?? "");
  return calls.filter((id) => !answered.includes(id)).length;
}

/** One thread of the store, as the threads pane and its picker list it. */
export type ThreadSummary = {
  id: string;
  label: string | null;
  parentId: string | null;
  messageCount: number;
  /** The thread the program is in, the top of the active stack. */
  active: boolean;
  hidden: boolean;
};

export type CheckpointArgs = {
  id?: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;
  moduleId?: string;
  scopeName?: string;
  stepPath?: string;
  branchPath?: string[];
  loopStop?: LoopStopKind;
  label?: string | null;
  pinned?: boolean;
  moduleFingerprints?: Record<string, ModuleFingerprint>;
  usage?: unknown;
  traceId?: string;
  signature?: string;
};

export type CheckpointJSON = {
  id: number;
  stack: StateStackJSON;
  globals: GlobalStoreJSON;
  nodeId: string;
  moduleId: string;
  scopeName: string;
  stepPath: string;
  /** Present only for a checkpoint taken on a branch stack, so a
   *  checkpoint from before the field keeps its signature. */
  branchPath?: string[];
  /** Present only for a checkpoint taken at one of the tool loop's own
   *  stops. */
  loopStop?: LoopStopKind;
  label: string | null;
  pinned: boolean;
  moduleFingerprints?: Record<string, ModuleFingerprint>;
  usage?: unknown;
  traceId?: string;
  signature?: string;
};

/** A branch's status. `interruptId` is never cleared once set, so a
 *  branch that stopped on an interrupt and later returned has both
 *  fields; the result decides. */
function branchStatus(branch: BranchStateJSON): BranchSummary["status"] {
  if (branch.result !== undefined) return "done";
  if (branch.interruptId !== undefined) return "interrupted";
  return "running";
}

/** The name of the tool a loop frame called under the branch key
 *  `tool_<index>_<id>`, from the tool calls in the loop's copy of its
 *  thread; undefined when the frame is not a loop's or has no such call.
 *  A call with an id is matched by the id alone. Without one (Gemini
 *  sends none) the index decides, counted over the calls the loop
 *  dispatched, so an intrinsic call such as a draft save, which the loop
 *  handles inline, is not counted. Branches are dropped at the end of
 *  each round, so only the latest assistant message can own a live
 *  branch; the search starts from the end so an empty id cannot match an
 *  earlier round's call. */
function toolCallName(frame: StateJSON | undefined, key: string): string | undefined {
  if (frame?.scopeName !== "runPrompt") return undefined;
  const copy = frame.locals?.messagesJSON;
  const messages: unknown[] = Array.isArray(copy) ? copy : (copy?.messages ?? []);
  for (const message of [...messages].reverse()) {
    const calls = (message as { toolCalls?: { id?: string; name?: string }[] } | null)?.toolCalls;
    if (!Array.isArray(calls)) continue;
    const withId = calls.find((call) => call.id && key.endsWith(`_${call.id}`));
    if (withId) return withId.name;
    const dispatched = calls.filter((call) => !isIntrinsicToolName(call.name ?? ""));
    const index = dispatched.findIndex((call, i) => `tool_${i}_${call.id ?? ""}` === key);
    if (index >= 0) return dispatched[index].name;
  }
  return undefined;
}

/** A thread as the panes see it: the store's key, its JSON, whether the
 *  program is in it, and a newer copy of its messages when a tool loop
 *  holds one. */
export type ThreadView = {
  key: string;
  thread: MessageThreadJSON;
  active: boolean;
  newer?: MessageJSON[];
  /** Where the messages a resume reads are in the checkpoint's JSON:
   *  the loop's copy when a loop frame holds one, else the store's. */
  jsonPath: string[];
};

/** The thread a tool loop's frame is working on, from `messagesJSON` in
 *  its locals. Only the loop's own frame is read; a user's local of the same
 *  name in a node or a function is a value, not a thread. An entry that
 *  is not an object is dropped, so a bad value cannot break the pane. */
function loopThreadCopy(frame: StateJSON): MessageThreadJSON | null {
  if (frame.scopeName !== "runPrompt") return null;
  const copy = frame.locals?.messagesJSON;
  if (!copy || !Array.isArray(copy.messages)) return null;
  const messages = copy.messages.filter(
    (m: unknown): m is MessageJSON => typeof m === "object" && m !== null,
  );
  return { ...copy, messages };
}

/** The name a pane shows for a frame: the tool loop's own frame reads
 *  `llm()`, the compiler-named frame of a fork or parallel arm or a block
 *  argument reads `block`, and a frame with no scope name `(unknown)`. */
export function frameName(scopeName: string | null | undefined): string {
  if (scopeName === undefined || scopeName === null) return "(unknown)";
  if (scopeName === "runPrompt") return "llm()";
  if (isBlockName(scopeName)) return "block";
  return scopeName;
}

export class Checkpoint implements SourceLocation {
  public id: number;
  public stack: StateStackJSON;
  public globals: GlobalStoreJSON;
  public nodeId: string;
  public moduleId: string;
  public scopeName: string;
  public stepPath: string;
  /** The branch keys from the root stack down to the stack the step ran
   *  on, empty for the root. `getCurrentFrame` follows it. */
  public branchPath: string[];
  /** Set for a checkpoint taken at one of the tool loop's own stops,
   *  before a model request or a tool call. See `SourceLocation`. */
  public loopStop?: LoopStopKind;
  public label: string | null;
  public pinned: boolean;
  /** The fingerprint (a hash of the generated code) of each module with a
   *  live frame, captured at creation so a resume can refuse when the code
   *  changed. */
  public moduleFingerprints?: Record<string, ModuleFingerprint>;
  /** What the run had spent when this checkpoint was taken, so a resumed run
   *  keeps counting from there. `unknown` because a checkpoint comes back from
   *  the host; `InvocationUsageMeter.resumeFrom` recovers it. */
  public usage?: unknown;
  /** The statelog trace the run was logging to when this checkpoint was
   *  taken, so a resume from a file can log into the same trace. Absent on
   *  checkpoints from before the field and on contexts with no run id. */
  public traceId?: string;
  /** HMAC checksum embedded at creation when a signing key is configured.
   *  Absent on unsigned checkpoints. See lib/runtime/checkpointChecksum.ts. */
  public signature?: string;

  constructor(args: CheckpointArgs) {
    this.id = args.id ?? globalCheckpointCounter++;
    this.stack = args.stack;
    this.globals = args.globals;
    this.nodeId = args.nodeId;
    this.moduleId = args.moduleId ?? "";
    this.scopeName = args.scopeName ?? "";
    this.stepPath = args.stepPath ?? "";
    this.branchPath = args.branchPath ?? [];
    this.loopStop = args.loopStop;
    this.label = args.label ?? null;
    this.pinned = args.pinned ?? false;
    this.moduleFingerprints = args.moduleFingerprints;
    this.usage = args.usage;
    this.traceId = args.traceId;
    this.signature = args.signature;
  }

  getScopeKey(): string {
    return `${this.moduleId}:${this.scopeName}`;
  }

  /** The location, with `branchPath` only when the step ran on a branch
   *  stack, as `toJSON` writes it. */
  get location(): SourceLocation {
    const location: SourceLocation = {
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
    };
    if (this.branchPath.length > 0) {
      location.branchPath = this.branchPath;
    }
    if (this.loopStop !== undefined) {
      location.loopStop = this.loopStop;
    }
    return location;
  }

  /** The frame the checkpoint was taken in: the last frame of the stack
   *  its branch path leads to. For a step inside a tool call that is the
   *  tool's frame, not the root's last frame. Undefined when the path
   *  names a branch the checkpoint does not hold. */
  getCurrentFrame(): StateJSON | undefined {
    return this.frameAt(this.branchPath);
  }

  /** The last frame of the stack `branchPath` leads to, from the root. */
  frameAt(branchPath: string[]): StateJSON | undefined {
    return this.stackAt(branchPath)?.at(-1);
  }

  /** The frames of the stack `branchPath` leads to, from the root;
   *  undefined when the path names a branch the checkpoint does not
   *  hold. */
  stackAt(branchPath: string[]): StateJSON[] | undefined {
    const stacks = this.stacksAlong(branchPath);
    return stacks.length === branchPath.length + 1 ? stacks.at(-1)!.frames : undefined;
  }

  /** The frames from the root down the branch path, the deepest last:
   *  every frame of every stack the path passes through. */
  framesAlong(branchPath: string[]): StateJSON[] {
    return this.walkFrames(branchPath).map((at) => at.frame);
  }

  /** Every frame along `branchPath`, root first, each with its path in
   *  the checkpoint's JSON. The one walk the readers and the patch
   *  library share, so the layout of the JSON is known here and nowhere
   *  else. A path that names a branch the checkpoint does not hold
   *  stops at the last stack it reaches. */
  walkFrames(branchPath: string[]): FrameAt[] {
    return this.stacksAlong(branchPath).flatMap((stack) =>
      stack.frames.map((frame, index) => ({
        frame,
        jsonPath: [...stack.jsonPath, "stack", String(index)],
      })),
    );
  }

  /** The stacks along `branchPath`, the root first, each with the path
   *  of its `StateStackJSON`. A branch hangs off the last frame of the
   *  stack above it. */
  private stacksAlong(branchPath: string[]): { frames: StateJSON[]; jsonPath: string[] }[] {
    const stacks: { frames: StateJSON[]; jsonPath: string[] }[] = [];
    let frames: StateJSON[] | undefined = this.stack.stack;
    let jsonPath = ["stack"];
    for (const key of [undefined, ...branchPath]) {
      if (key !== undefined) {
        const last = frames?.length ? frames.length - 1 : undefined;
        const branch: BranchStateJSON | undefined = frames?.at(-1)?.branches?.[key];
        if (last === undefined || !branch) break;
        jsonPath = [...jsonPath, "stack", String(last), "branches", key, "stack"];
        frames = branch.stack.stack;
      }
      stacks.push({ frames: frames ?? [], jsonPath });
    }
    return stacks;
  }

  /** The path of the stack `branchPath` leads to, or undefined when the
   *  checkpoint does not hold it. */
  private stackPathAt(branchPath: string[]): string[] | undefined {
    const stacks = this.stacksAlong(branchPath);
    return stacks.length === branchPath.length + 1 ? stacks.at(-1)!.jsonPath : undefined;
  }

  /** The path to the branch paused on the interrupt `interruptId`, or
   *  undefined when no branch is. A user interrupt raised inside a tool,
   *  a fork, or a parallel arm has no stop record to say which branch it
   *  came from, but the branch's own state records the interrupt's id.
   *  An interrupt bubbles up unchanged, so every enclosing branch records
   *  the same id (`setInterruptOnBranch` in `prompt.ts` and `runBatch.ts`);
   *  the deepest match is the branch that raised it. Only the last frame
   *  of a stack holds branches, as `stackAt` reads. */
  branchPathOf(interruptId: string): string[] | undefined {
    const search = (frames: StateJSON[], path: string[]): string[] | undefined => {
      const branches = frames.at(-1)?.branches ?? {};
      for (const key of Object.keys(branches)) {
        const branch = branches[key];
        const here = [...path, key];
        const below = search(branch.stack.stack, here);
        if (below) {
          return below;
        }
        if (branch.interruptId === interruptId) {
          return here;
        }
      }
      return undefined;
    };
    return search(this.stack.stack, []);
  }

  /** The frame a person inspects at a location: the frame the step ran
   *  in, or, at one of the tool loop's own stops, the frame that called
   *  `llm()`, the one under the loop's frame. */
  shownFrame(location: { branchPath?: string[]; loopStop?: LoopStopKind }): StateJSON | undefined {
    const frames = this.stackAt(location.branchPath ?? []);
    return frames?.at(location.loopStop === undefined ? -1 : -2);
  }

  /** The last frame of the root stack. */
  private rootFrame(): StateJSON | undefined {
    return this.stack.stack?.at(-1);
  }

  /** The active stack of the deepest `fork` or `parallel` branch on the
   *  path, when there is one. Such a branch runs on a view of the node's
   *  store with its own active stack, serialized with the branch; a tool
   *  call shares its caller's and has none. */
  private branchActiveStack(branchPath: string[]): string[] | undefined {
    let frame = this.rootFrame();
    let activeStack: string[] | undefined;
    for (const key of branchPath) {
      // A tool call runs on a fresh store that is not serialized, so an
      // arm below it names threads the checkpoint does not hold; an arm
      // above the tool is still the one the tool's threads hang off.
      if (key.startsWith("tool_")) break;
      const branch = frame?.branches?.[key];
      if (branch?.activeStack) activeStack = branch.activeStack;
      frame = branch?.stack.stack.at(-1);
    }
    return activeStack;
  }

  /** The threads the stopped code can see, from two places in the
   *  checkpoint. The node frame carries the thread store, with the thread
   *  the program is in at the top of the active stack: the store's own,
   *  or the branch's inside a `fork` or `parallel` arm. A tool loop's
   *  frame carries `messagesJSON`, the thread it is working on, refreshed
   *  on every checkpoint. When its `id` matches a store thread it is the
   *  copy shown, since a resume continues from it, whatever the lengths.
   *  A loop inside a tool runs on a fresh store
   *  that is not serialized, so its copy is the only record of the
   *  thread: it is listed under its own id, named after the function that
   *  called `llm()`, with no parent, since its `parentId` names a thread
   *  of the store that was not serialized. */
  threadsAlong(branchPath: string[]): ThreadView[] {
    const along = this.walkFrames(branchPath);
    const storeAt = along.findLast((at) => at.frame.threads);
    const store = storeAt?.frame.threads;
    const views: ThreadView[] = [];
    if (store && storeAt) {
      const activeStack = this.branchActiveStack(branchPath) ?? store.activeStack;
      const activeId = activeStack.findLast((id) => store.threads[id] != null);
      for (const [key, thread] of Object.entries(store.threads)) {
        views.push({
          key,
          thread,
          active: key === activeId,
          jsonPath: [...storeAt.jsonPath, "threads", "threads", key, "messages"],
        });
      }
    }
    along.forEach(({ frame, jsonPath }, index) => {
      const copy = loopThreadCopy(frame);
      if (!copy) return;
      const copyPath = [...jsonPath, "locals", "messagesJSON", "messages"];
      const stored = views.find((view) => copy.id !== undefined && view.thread.id === copy.id);
      if (stored) {
        stored.newer = copy.messages;
        stored.jsonPath = copyPath;
        return;
      }
      if (copy.id === undefined) return;
      for (const view of views) view.active = false;
      views.push({
        key: copy.id,
        thread: {
          ...copy,
          label: copy.label ?? along[index - 1]?.frame.scopeName ?? null,
          parentId: null,
        },
        active: true,
        jsonPath: copyPath,
      });
    });
    return views;
  }

  /** Every thread the stopped code can see, in the checkpoint's order,
   *  with the one the program is in marked. Empty when the checkpoint
   *  holds no threads. */
  listThreads(branchPath: string[] = []): ThreadSummary[] {
    return this.threadsAlong(branchPath).map((view) => ({
      id: view.key,
      label: view.thread.label ?? null,
      parentId: view.thread.parentId ?? null,
      messageCount: (view.newer ?? view.thread.messages).length,
      active: view.active,
      hidden: view.thread.hidden === true,
    }));
  }

  /** The messages of one thread, `threadId`, or of the thread the program
   *  is in when none is named. */
  getThreadMessages(threadId?: string, branchPath: string[] = []): ThreadMessages | null {
    const views = this.threadsAlong(branchPath);
    if (views.length === 0) return null;
    const selected =
      views.find((view) => view.key === threadId) ?? views.find((view) => view.active) ?? views[0];
    return {
      threadId: selected.key,
      label: selected.thread.label ?? null,
      threadIndex: views.indexOf(selected),
      threadCount: views.length,
      messages: (selected.newer ?? selected.thread.messages).map((m: MessageJSON) => ({
        role: m.role ?? "unknown",
        content: this.getContentFromMessage(m),
      })),
    };
  }

  private getContentFromMessage(message: MessageJSON): string {
    if (typeof message.content === "string") {
      return message.content;
    } else if (Array.isArray(message.content)) {
      return message.content.map((part) => part.text ?? "").join("");
    } else if (message.content == null) {
      if (message.role === "assistant" && message.toolCalls) {
        return message.toolCalls
          .map((toolCall) => `Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})`)
          .join("\n");
      }
      return "(no content)";
    }
    return JSON.stringify(message.content);
  }

  /** The stack `branchPath` leads to, as serialized. */
  private stackJSONAt(branchPath: string[]): StateStackJSON | undefined {
    let stack: StateStackJSON | undefined = this.stack;
    for (const key of branchPath) {
      stack = stack?.stack?.at(-1)?.branches?.[key]?.stack;
    }
    return stack;
  }

  /** Every branch in the checkpoint, from the root stack down through
   *  the stacks of the branches themselves, in the order the checkpoint
   *  holds them. Stopped inside one tool, a person sees its siblings.
   *  Only the last frame of a stack holds branches, as `stackAt` reads.
   *  A finished branch has no frames, since a function pops its frame
   *  when it returns, so its name comes from the tool loop's record of
   *  the call, when the loop is the owner. */
  listBranches(): BranchSummary[] {
    const branches: BranchSummary[] = [];
    const visit = (frames: StateJSON[] | undefined, path: string[], stackPath: string[]) => {
      const frame = frames?.at(-1);
      const framePath = [...stackPath, "stack", String((frames?.length ?? 1) - 1)];
      for (const [key, branch] of Object.entries(frame?.branches ?? {})) {
        const branchPathHere = [...path, key];
        const jsonPath = [...framePath, "branches", key];
        const first = branch.stack.stack?.[0]?.scopeName ?? undefined;
        branches.push({
          path: branchPathHere,
          jsonPath,
          key,
          owner: frameName(frame?.scopeName),
          label: first === undefined ? (toolCallName(frame, key) ?? key) : frameName(first),
          status: branchStatus(branch),
        });
        visit(branch.stack.stack, branchPathHere, [...jsonPath, "stack"]);
      }
    };
    visit(this.stack.stack, [], ["stack"]);
    return branches;
  }

  /** The guards the stopped code runs under, outermost first: those on
   *  each stack along `branchPath`, a stack's inherited ones before its
   *  own. A branch stack serializes the time guards it inherited, since
   *  their elapsed time is its own: each is a clone with the parent's
   *  guard id, the parent's remaining time as its limit, and the branch's
   *  working time as spent. A guard is listed once, in the place of its
   *  outermost copy, with the figures of the deepest, which are the ones
   *  the stopped code is metered by. A cost guard is shared by reference,
   *  so a branch never serializes an inherited one. */
  listGuards(branchPath: string[] = []): GuardSummary[] {
    const guards: GuardSummary[] = [];
    const indexById: Record<string, number> = {};
    for (let depth = 0; depth <= branchPath.length; depth++) {
      const stack = this.stackJSONAt(branchPath.slice(0, depth));
      const stackPath = this.stackPathAt(branchPath.slice(0, depth)) ?? [];
      const own = stack?.guards ?? [];
      const inherited = stack?.inheritedTimeGuards ?? [];
      for (const guard of [...inherited, ...own]) {
        const isInherited = inherited.includes(guard);
        const list = isInherited ? inherited : own;
        const jsonPath = [
          ...stackPath,
          isInherited ? "inheritedTimeGuards" : "guards",
          String(list.indexOf(guard)),
        ];
        const summary: GuardSummary = {
          label: guard.label ?? null,
          dimension: guard.kind,
          limit: guard.kind === "cost" ? guard.costLimit : guard.timeLimit,
          spent: guard.kind === "cost" ? guard.spent : guard.elapsedMs,
          disarmed: guard.disarmed === true,
          root: guard.isRootBudget === true,
          inherited: isInherited,
          jsonPaths: [jsonPath],
        };
        const seen = guard.guardId === undefined ? undefined : indexById[guard.guardId];
        if (seen !== undefined) {
          summary.jsonPaths = [...guards[seen].jsonPaths, jsonPath];
          guards[seen] = summary;
          continue;
        }
        if (guard.guardId !== undefined) {
          indexById[guard.guardId] = guards.length;
        }
        guards.push(summary);
      }
    }
    return guards;
  }

  /** The tool loop the stopped code is in, from the deepest loop frame
   *  along `branchPath`; null outside any `llm()` call. */
  loopState(branchPath: string[] = []): LoopState | null {
    const at = this.walkFrames(branchPath).findLast(
      ({ frame }) => frame.scopeName === "runPrompt" && frame.locals?.toolCallRound !== undefined,
    );
    if (!at) return null;
    const { frame, jsonPath } = at;
    return {
      round: frame.locals.toolCallRound + 1,
      removedTools: Array.isArray(frame.locals.removedTools) ? frame.locals.removedTools : [],
      tools: Array.isArray(frame.locals.toolNames) ? frame.locals.toolNames : null,
      jsonPath,
    };
  }

  getGlobalsForModule(): Record<string, any> | null {
    return this.globals.store?.[this.moduleId] ?? null;
  }

  /** The globals the stack `branchPath` leads to sees. A `fork` or
   *  `parallel` branch runs on its own copy of the globals (`runBatch`
   *  saves it as the branch's `globalsJSON` before every checkpoint), so
   *  a module-level variable it changed has the branch's value here and
   *  the root's in `globals`. A branch that shares the globals, a tool
   *  call, has no copy and sees the nearest copy above it, or the root's. */
  globalsAt(branchPath: string[]): GlobalStoreJSON {
    return this.globalsAlong(branchPath).globals;
  }

  /** `globalsAt`, with where in the JSON that store is. */
  globalsLocation(branchPath: string[]): GlobalsLocation {
    const { globals, jsonPath } = this.globalsAlong(branchPath);
    return { store: globals.store, jsonPath: [...jsonPath, "store"] };
  }

  private globalsAlong(branchPath: string[]): { globals: GlobalStoreJSON; jsonPath: string[] } {
    let globals = this.globals;
    let jsonPath = ["globals"];
    const branches = this.listBranches();
    for (let depth = 1; depth <= branchPath.length; depth++) {
      const here = branchPath.slice(0, depth);
      const branch = branches.find((b) => b.path.join("/") === here.join("/"));
      const record = this.branchRecordAt(here);
      if (branch && record?.globalsJSON) {
        globals = record.globalsJSON;
        jsonPath = [...branch.jsonPath, "globalsJSON"];
      }
    }
    return { globals, jsonPath };
  }

  /** The branch's own record (its stack, result, globals copy). */
  private branchRecordAt(branchPath: string[]): BranchStateJSON | undefined {
    let frame = this.rootFrame();
    let record: BranchStateJSON | undefined;
    for (const key of branchPath) {
      record = frame?.branches?.[key];
      frame = record?.stack.stack.at(-1);
    }
    return record;
  }

  getFilename(): string {
    return this.moduleId.split("/").pop() || this.moduleId;
  }

  pathEquals(other: Checkpoint): boolean {
    return sameLocation(this, other);
  }

  equals(other: Checkpoint): boolean {
    return JSON.stringify(this.toJSON()) === JSON.stringify(other.toJSON());
  }

  toJSON(): CheckpointJSON {
    const json: CheckpointJSON = {
      id: this.id,
      stack: this.stack,
      globals: this.globals,
      nodeId: this.nodeId,
      moduleId: this.moduleId,
      scopeName: this.scopeName,
      stepPath: this.stepPath,
      label: this.label,
      pinned: this.pinned,
    };
    if (this.branchPath.length > 0) {
      json.branchPath = this.branchPath;
    }
    if (this.loopStop !== undefined) {
      json.loopStop = this.loopStop;
    }
    if (this.moduleFingerprints !== undefined) {
      json.moduleFingerprints = this.moduleFingerprints;
    }
    if (this.usage !== undefined) {
      json.usage = this.usage;
    }
    if (this.traceId !== undefined) {
      json.traceId = this.traceId;
    }
    if (this.signature !== undefined) {
      json.signature = this.signature;
    }
    return json;
  }

  /** A copy with `opts` applied, re-signed under `settings` when this
   *  checkpoint was signed, since `opts` may change signed fields
   *  (typically `id`). */
  clone(opts: Partial<CheckpointArgs>, settings: HostSettings): Checkpoint {
    const copy = Checkpoint.fromJSON({ ...this.toJSON(), ...opts })!;
    if (copy.signature !== undefined) {
      signCheckpoint(copy, settings);
    }
    return copy;
  }

  getLocation(): string {
    return `${this.moduleId}:${this.scopeName}#${this.stepPath}`;
  }

  static fromStateStack(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label?: string | null; pinned?: boolean },
  ): Checkpoint {
    const nodeId = ctx.stateStack.currentNodeId();
    if (!nodeId) {
      throw new CheckpointError(
        "Cannot create checkpoint: no current node id in state stack. This error can happen if you call a function that throws an interrupt from the global namespace. Please use `const foo = funcName() with approve` syntax.",
      );
    }
    // Live state that is only written into the stack on demand: a tool
    // loop's thread, a branch's own globals. Every checkpoint, from any
    // stack and for any reason, is taken after these run.
    for (const refresh of ctx.beforeCheckpoint) {
      refresh();
    }
    const stackJson = stateStack.toJSON();
    // Optional only for contexts built by hand in tests; a real context always
    // has a meter.
    const usage: RunUsage | undefined = ctx.invocationUsage?.snapshot();
    const moduleFingerprints = collectModuleFingerprints(stackJson);
    const args: CheckpointArgs = {
      stack: stackJson,
      globals: ctx.globals.toJSON(),
      nodeId,
      usage,
      traceId: ctx.runId ?? undefined,
      ...opts,
    };
    if (Object.keys(moduleFingerprints).length > 0) {
      args.moduleFingerprints = moduleFingerprints;
    }
    const checkpoint = new Checkpoint(args);
    // Keep this the last statement: the signature must cover every field,
    // moduleFingerprints included.
    signCheckpoint(checkpoint, ctx.host.settings);
    return checkpoint;
  }

  static fromContext(
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & { label?: string | null; pinned?: boolean },
  ): Checkpoint {
    return Checkpoint.fromStateStack(ctx.stateStack, ctx, opts);
  }

  static fromJSON(json: any): Checkpoint | null {
    if (json instanceof Checkpoint) {
      return json;
    }
    const parsed = checkpointSchema.safeParse(json);
    if (!parsed.success) {
      return null;
    }
    return new Checkpoint(parsed.data);
  }
}

export type CheckpointStoreJSON = {
  checkpoints: Record<number, Checkpoint>;
  counter: number;
};

export class CheckpointStore {
  private checkpoints: Record<number, Checkpoint> = {};
  private restoreCounts: Record<number, number> = {};
  private locationRestoreCounts: Record<string, number> = {};
  private maxRestores: number;
  private maxSize: number;

  constructor(maxRestores = 100, maxSize = -1) {
    this.maxRestores = maxRestores;
    this.maxSize = maxSize;
  }

  create(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & {
      label?: string | null;
      pinned?: boolean;
      removeDuplicate?: boolean;
    },
  ): number {
    if (opts.removeDuplicate) {
      this.removeDuplicate(opts);
    }

    const checkpoint = Checkpoint.fromStateStack(stateStack, ctx, opts);
    this.checkpoints[checkpoint.id] = checkpoint;
    return checkpoint.id;
  }

  add(checkpoint: Checkpoint): void {
    this.checkpoints[checkpoint.id] = checkpoint;
    if (checkpoint.id >= globalCheckpointCounter) {
      globalCheckpointCounter = checkpoint.id + 1;
    }
  }

  cloneCheckpoint(
    _checkpoint: Checkpoint,
    opts: Partial<CheckpointArgs>,
    settings: HostSettings,
  ): number {
    const checkpoint = Checkpoint.fromJSON(_checkpoint);
    if (!checkpoint) {
      throw new CheckpointError("Invalid checkpoint provided for cloning.");
    }
    const id = globalCheckpointCounter++;
    const newCheckpoint = checkpoint.clone({ ...opts, id }, settings);
    this.checkpoints[id] = newCheckpoint;
    return id;
  }

  findCheckpoint(location: SourceLocationOpts): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    const currentIdx = sorted.findIndex((cp) => sameLocation(cp, location));
    if (currentIdx <= 0) return null;
    return sorted[currentIdx - 1];
  }

  /** The newest unpinned checkpoint older than `beforeId` whose step ran
   *  on the stack the program is stopped on, or on a stack above it, and
   *  not at `location`, the step it is stopped at. `step back` rewinds to
   *  it. A sibling branch's steps are passed over: stopped inside one tool
   *  of a round, `step back` must not land in the other tool. The stopped
   *  location is passed on its own because the checkpoint on a stop
   *  inside a tool call is the shared one stamped at the join, whose own
   *  location is the loop's. */
  findBefore(beforeId: number, location: SourceLocationOpts): Checkpoint | null {
    const sorted = this.getSorted(); // sorted by id ascending
    sorted.reverse();
    for (const cp of sorted) {
      if (cp.id >= beforeId || cp.pinned) continue;
      if (onStackOrAbove(cp, location) && !sameLocation(cp, location)) {
        return cp;
      }
    }
    return null;
  }

  createRolling(ctx: RuntimeContext<any>, opts: SourceLocationOpts): number {
    // Remove existing unpinned checkpoint at the same location to avoid duplicates
    const id = this.create(ctx.stateStack, ctx, {
      ...opts,
      label: null,
      pinned: false,
      removeDuplicate: true,
    });
    this.removeDebugFlagsFor(id);
    this.evictIfNeeded();
    return id;
  }

  /** Strip the `__dbg_` flags from the frame the checkpoint was taken in,
   *  and from that frame only, so a replay stops there again. Ancestor
   *  frames keep theirs: a rewind into a tool call must pass through the
   *  `llm()` statement without stopping, and a sibling branch that was
   *  mid-step keeps its flag so it replays past its own stop. */
  removeDebugFlagsFor(id: number): void {
    const cp = this.checkpoints[id];
    if (!cp) return;
    const frame = cp.getCurrentFrame();
    if (!frame || !frame.locals) return;
    for (const key of Object.keys(frame.locals)) {
      if (key.startsWith("__dbg_")) {
        delete frame.locals[key];
      }
    }
  }

  private removeDuplicate(location: SourceLocationOpts): void {
    for (const [id, cp] of Object.entries(this.checkpoints)) {
      if (!cp.pinned && sameLocation(cp, location)) {
        delete this.checkpoints[Number(id)];
        return;
      }
    }
  }

  createPinned(
    stateStack: StateStack,
    ctx: RuntimeContext<any>,
    opts: SourceLocationOpts & {
      label: string | null;
    },
  ): number {
    return this.create(stateStack, ctx, { ...opts, pinned: true });
  }

  /** Mark a checkpoint pinned, re-signing it under `settings` when it was
   *  signed: `pinned` and `label` are signed fields. */
  pin(id: number, label: string | undefined, settings: HostSettings): void {
    const cp = this.checkpoints[id];
    if (!cp) return;
    cp.pinned = true;
    if (label !== undefined) cp.label = label;
    if (cp.signature !== undefined) {
      signCheckpoint(cp, settings);
    }
  }

  get(id: number): Checkpoint | undefined {
    const cp = this.checkpoints[id];
    return cp;
  }

  delete(id: number): void {
    delete this.checkpoints[id];
    delete this.restoreCounts[id];
  }

  getCheckpoints(): Checkpoint[] {
    return Object.values(this.checkpoints).filter(Boolean);
  }

  // Invalidate all checkpoints with id > the given id
  deleteAfterCheckpoint(id: number, deletePinned = false): void {
    for (const key of Object.keys(this.checkpoints)) {
      const numericKey = Number(key);
      if (numericKey > id) {
        if (!deletePinned && this.checkpoints[numericKey].pinned) {
          continue;
        }
        delete this.checkpoints[numericKey];
        delete this.restoreCounts[numericKey];
      }
    }
  }

  getLocationRestoreCount(location: string): number {
    return this.locationRestoreCounts[location] || 0;
  }

  trackLocationRestore(location: string): void {
    this.locationRestoreCounts[location] = (this.locationRestoreCounts[location] || 0) + 1;
  }

  trackRestore(id: number): void {
    this.restoreCounts[id] = (this.restoreCounts[id] || 0) + 1;
    if (this.restoreCounts[id] > this.maxRestores) {
      throw new CheckpointError(
        `Checkpoint ${id} has been restored ${this.maxRestores} times. Possible infinite loop.`,
      );
    }
  }

  getSorted(): Checkpoint[] {
    return Object.values(this.checkpoints).sort((a, b) => a.id - b.id);
  }

  prettyPrint(): string {
    const cps = this.getSorted()
      .map(
        (cp) =>
          `Checkpoint ${cp.id}: nodeId=${cp.nodeId}, moduleId=${cp.moduleId}, scopeName=${cp.scopeName}, stepPath=${cp.stepPath}, label=${cp.label}, pinned=${cp.pinned}`,
      )
      .join("\n");
    return cps || "No checkpoints";
  }

  toJSON(): CheckpointStoreJSON {
    return {
      checkpoints: deepClone(this.checkpoints),
      counter: globalCheckpointCounter,
    };
  }

  static fromJSON(json: CheckpointStoreJSON, maxRestores = 100): CheckpointStore {
    const store = new CheckpointStore(maxRestores);
    const rehydrated: Record<number, Checkpoint> = {};
    for (const [id, cpJson] of Object.entries(json.checkpoints)) {
      const checkpoint = Checkpoint.fromJSON(cpJson);
      if (checkpoint) {
        rehydrated[Number(id)] = checkpoint;
      } else {
        console.warn(
          `Failed to rehydrate checkpoint with id ${id}, skipping. Data: ${JSON.stringify(cpJson)}`,
        );
      }
    }
    store.checkpoints = rehydrated;
    globalCheckpointCounter = Math.max(globalCheckpointCounter, json.counter);
    return store;
  }

  private evictIfNeeded(): void {
    if (this.maxSize < 0) return; // no max size limit
    const unpinned = Object.values(this.checkpoints)
      .filter((cp) => !cp.pinned)
      .sort((a, b) => a.id - b.id);
    while (unpinned.length > this.maxSize) {
      const oldest = unpinned.shift()!;
      delete this.checkpoints[oldest.id];
    }
  }
}
