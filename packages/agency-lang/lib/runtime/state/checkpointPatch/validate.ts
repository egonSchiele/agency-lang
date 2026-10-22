import { pendingToolCalls, type Checkpoint } from "../checkpointStore.js";
import type { MessageLike } from "../checkpointStore.js";
import type { StateStackJSON } from "../stateStack.js";
import type { Refusal } from "./edits.js";
import { getAt } from "./jsonPath.js";

/** One invariant a patched checkpoint must keep. `check` returns a
 *  message per place the invariant is broken. The checkpoint is handed
 *  in parsed, so no rule parses it again. */
export type ValidationRule = {
  name: string;
  check: (checkpoint: Checkpoint) => string[];
};

/** Every stack in the checkpoint: the root's and each branch's, found
 *  by walking the branches off every frame. */
function everyStack(checkpoint: Checkpoint): StateStackJSON[] {
  const stacks: StateStackJSON[] = [];
  const visit = (stack: StateStackJSON | undefined) => {
    if (!stack) return;
    stacks.push(stack);
    for (const frame of stack.stack ?? []) {
      for (const branch of Object.values(frame.branches ?? {})) visit(branch.stack);
    }
  };
  visit(checkpoint.stack);
  return stacks;
}

/** A thread whose last assistant message made calls with no result must
 *  have a running branch for each, or the loop would send a request
 *  the provider refuses. Checked on every loop frame's copy of its
 *  thread, where the calls and the branches sit together. */
const unansweredToolCall: ValidationRule = {
  name: "unanswered tool call",
  check: (checkpoint) => {
    const json = checkpoint.toJSON();
    const paths = [[], ...checkpoint.listBranches().map((branch) => branch.path)];
    const seen: string[] = [];
    const problems: string[] = [];
    for (const branchPath of paths) {
      for (const view of checkpoint.threadsAlong(branchPath)) {
        const key = view.jsonPath.join("/");
        const inLoop = view.jsonPath.at(-2) === "messagesJSON";
        if (!inLoop || seen.includes(key)) continue;
        seen.push(key);
        const messages = (getAt(json, view.jsonPath) as MessageLike[] | undefined) ?? [];
        if (pendingToolCalls({ messages }) === 0) continue;
        const frame = getAt(json, view.jsonPath.slice(0, -3)) as {
          branches?: Record<string, { result?: unknown }>;
        };
        const last = messages.findLast((m) => m.role === "assistant" && m.toolCalls?.length);
        const answered = messages.map((m) => m.toolCallId).filter((id) => id !== undefined);
        for (const call of last?.toolCalls ?? []) {
          if (answered.includes(call.id ?? "")) continue;
          const running = Object.entries(frame.branches ?? {}).some(
            ([branchKey, branch]) =>
              branchKey.endsWith(`_${call.id ?? ""}`) && branch.result === undefined,
          );
          if (!running) {
            const name = view.thread.label ?? view.key;
            problems.push(`thread ${name} ends in a call to ${call.name} with no result`);
          }
        }
      }
    }
    return problems;
  },
};

/** A guard past its limit trips at the next check unless it is
 *  disarmed, so lowering a limit under what is spent is refused. */
const guardOverLimit: ValidationRule = {
  name: "guard over its limit",
  check: (checkpoint) => {
    const problems: string[] = [];
    for (const stack of everyStack(checkpoint)) {
      for (const guard of [...(stack.guards ?? []), ...(stack.inheritedTimeGuards ?? [])]) {
        const limit = guard.kind === "cost" ? guard.costLimit : guard.timeLimit;
        const spent = guard.kind === "cost" ? guard.spent : guard.elapsedMs;
        if (spent > limit && guard.disarmed !== true) {
          problems.push(`${guard.label ?? "guard"} would trip at once (${spent} of ${limit})`);
        }
      }
    }
    return problems;
  },
};

export const VALIDATION_RULES: ValidationRule[] = [unansweredToolCall, guardOverLimit];

/** The invariants `result` breaks that `source` kept, each named after
 *  its rule. The source decides what counts: a checkpoint the debugger
 *  stops on may already break a rule (a tripped guard, a tool stop's
 *  unanswered calls), and an edit that touches neither must go through.
 *  The shape is not a rule here: `result` is parsed before it is
 *  validated, and a copy that does not parse never reaches this. */
export function validate(source: Checkpoint, result: Checkpoint): Refusal[] {
  const refusals: Refusal[] = [];
  for (const rule of VALIDATION_RULES) {
    const before = rule.check(source);
    for (const problem of rule.check(result)) {
      if (before.includes(problem)) continue;
      refusals.push({ refused: `${rule.name}: ${problem}` });
    }
  }
  return refusals;
}
