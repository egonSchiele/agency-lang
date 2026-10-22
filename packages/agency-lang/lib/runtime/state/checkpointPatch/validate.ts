import { Checkpoint, pendingToolCalls, type CheckpointJSON } from "../checkpointStore.js";
import type { MessageLike } from "../checkpointStore.js";
import { checkpointSchema } from "../schemas.js";
import type { StateStackJSON } from "../stateStack.js";
import type { Refusal } from "./edits.js";
import { getAt } from "./jsonPath.js";

/** One invariant a patched checkpoint must keep. `check` returns a
 *  message per place the invariant is broken. */
export type ValidationRule = {
  name: string;
  check: (json: CheckpointJSON) => string[];
};

/** Every stack in the checkpoint: the root's and each branch's, found
 *  by walking the branches off every frame. */
function everyStack(json: CheckpointJSON): StateStackJSON[] {
  const stacks: StateStackJSON[] = [];
  const visit = (stack: StateStackJSON | undefined) => {
    if (!stack) return;
    stacks.push(stack);
    for (const frame of stack.stack ?? []) {
      for (const branch of Object.values(frame.branches ?? {})) visit(branch.stack);
    }
  };
  visit(json.stack);
  return stacks;
}

/** A thread whose last assistant message made calls with no result must
 *  have a running branch for each, or the loop would send a request
 *  the provider refuses. Checked on every loop frame's copy of its
 *  thread, where the calls and the branches sit together. */
const unansweredToolCall: ValidationRule = {
  name: "unanswered tool call",
  check: (json) => {
    const checkpoint = Checkpoint.fromJSON(json);
    if (!checkpoint) return [];
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
  check: (json) => {
    const problems: string[] = [];
    for (const stack of everyStack(json)) {
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

/** The shape the runtime refuses on load is refused here. */
const shape: ValidationRule = {
  name: "shape",
  check: (json) => {
    const parsed = checkpointSchema.safeParse(json);
    return parsed.success ? [] : [parsed.error.issues.map((issue) => issue.message).join("; ")];
  },
};

export const VALIDATION_RULES: ValidationRule[] = [unansweredToolCall, guardOverLimit, shape];

/** The invariants `result` breaks that `source` kept, each named after
 *  its rule. The source decides what counts: a checkpoint the debugger
 *  stops on may already break a rule (a tripped guard, a tool stop's
 *  unanswered calls), and an edit that touches neither must go through. */
export function validate(source: CheckpointJSON, result: CheckpointJSON): Refusal[] {
  const refusals: Refusal[] = [];
  for (const rule of VALIDATION_RULES) {
    const before = rule.name === "shape" ? [] : rule.check(source);
    for (const problem of rule.check(result)) {
      if (before.includes(problem)) continue;
      refusals.push({ refused: `${rule.name}: ${problem}` });
    }
  }
  return refusals;
}
