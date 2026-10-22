import { freshRepeatStreak } from "./toolLoopGuards.js";

/** The tool loop's frame-backed locals, set once when `runPrompt` first
 *  enters a frame and restored with it after a checkpoint. Everything
 *  here is the loop's bookkeeping except `removedTools`, `messagesJSON`,
 *  and `toolNames`, which a debugger's edit may read or change
 *  (`docs/dev/runtime/checkpoint-patch.md`). */
export function initLoopFrame(self: Record<string, any>, args: Record<string, any>): void {
  if (self.__initialized === undefined) {
    self.__initialized = true;
    self.removedTools = args.removedTools || [];
    self.toolErrorCounts = {};
    self.rejectedCalls = [];
    self.rejectionCounts = {};
    self.repeatStreak = freshRepeatStreak();
    self.toolCallRound = 0;
    self.validationAttempt = 0;
    self.messagesJSON = null;
    self.pendingToolCalls = null;
  }
  // Recorded so a debugger's edit can check a tool name against them; a
  // checkpoint from before the field has none, and any name is accepted.
  const tools: any[] = args.clientConfig?.tools || [];
  self.toolNames ??= tools.map((tool) => tool.name);
}
