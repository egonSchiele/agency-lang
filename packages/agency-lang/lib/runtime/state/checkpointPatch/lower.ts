import { type Checkpoint, messageLanding, pendingToolCalls } from "../checkpointStore.js";
import type { MessageLike } from "../checkpointStore.js";
import type { GuardJSON } from "../../guard.js";
import {
  resolveBranch,
  resolveFrame,
  resolveGuard,
  resolveLoopFrame,
  resolveModule,
  resolveThread,
  type StopAt,
} from "./addresses.js";
import { isRefusal, type CheckpointEdit, type Refusal } from "./edits.js";
import { getAt } from "./jsonPath.js";

/** One write an edit lowers to: the path, the whole new value at it,
 *  and the line the UI prints for it. */
export type Write = { jsonPath: string[]; value: unknown; applied: string };

/** One copy of a guard in the checkpoint: the owning copy on the stack
 *  that pushed it, or a clone on a branch stack below. */
export type GuardCopy = { jsonPath: string[]; json: Partial<GuardJSON>; owner: boolean };

export type GuardChange = { limit?: number; disarmed?: boolean };

/** The writes a guard change means, over every copy. `disarmed` is
 *  written as given to each. A new cost limit goes to the owner only,
 *  since cost clones are rebuilt from it on resume. A new time limit
 *  goes to the owner, and each clone moves by the same difference: a
 *  clone's limit is the time the parent had left when the branch
 *  started, so its remaining time changes by what the budget did. */
export function guardWrites(copies: GuardCopy[], change: GuardChange): Write[] {
  const writes: Write[] = [];
  if (change.disarmed !== undefined) {
    const applied = change.disarmed ? "disarmed" : "armed";
    for (const copy of copies) {
      writes.push({ jsonPath: [...copy.jsonPath, "disarmed"], value: change.disarmed, applied });
    }
  }
  if (change.limit !== undefined) {
    const owner = copies.find((copy) => copy.owner);
    if (owner) {
      const field = owner.json.kind === "cost" ? "costLimit" : "timeLimit";
      const was = (owner.json as Record<string, unknown>)[field] as number;
      const applied = `limit ${was} → ${change.limit}`;
      writes.push({ jsonPath: [...owner.jsonPath, field], value: change.limit, applied });
      if (field === "timeLimit") {
        for (const clone of copies.filter((copy) => !copy.owner)) {
          const cloneWas = (clone.json as { timeLimit?: number }).timeLimit ?? 0;
          const value = cloneWas + (change.limit - was);
          writes.push({ jsonPath: [...clone.jsonPath, "timeLimit"], value, applied });
        }
      }
    }
  }
  return writes;
}

/** The writes `edit` means on `checkpoint`, stopped at `at`, or why it
 *  is refused. Each case picks a locator and a value; the layout of the
 *  JSON is the reader's business. */
export function resolve(
  edit: CheckpointEdit,
  checkpoint: Checkpoint,
  at: StopAt,
): Write[] | Refusal {
  const json = checkpoint.toJSON();
  switch (edit.op) {
    case "appendMessage": {
      const thread = resolveThread(edit.thread, checkpoint, at);
      if (isRefusal(thread)) return thread;
      const name = thread.found.thread.label ?? thread.found.key;
      const messages = (getAt(json, thread.jsonPath) as MessageLike[] | undefined) ?? [];
      const role = edit.role ?? "user";
      if (messageLanding({ messages }) === "queued") {
        const queuePath = [...thread.jsonPath.slice(0, -1), "queuedMessages"];
        const queue = (getAt(json, queuePath) as unknown[] | undefined) ?? [];
        const pending = pendingToolCalls({ messages });
        const noun = pending === 1 ? "tool result" : "tool results";
        return [
          {
            jsonPath: queuePath,
            value: [...queue, { role, content: edit.text, label: null }],
            applied: `queued on thread ${name}, delivered after ${pending} pending ${noun}`,
          },
        ];
      }
      const value = [...messages, { role, content: edit.text }];
      return [
        {
          jsonPath: thread.jsonPath,
          value,
          applied: `appended to thread ${name} (${value.length} messages)`,
        },
      ];
    }
    case "removeTool": {
      const loop = resolveLoopFrame(edit.loop, checkpoint, at);
      if (isRefusal(loop)) return loop;
      const { tools, removedTools } = loop.found;
      if (tools !== null && !tools.includes(edit.tool)) {
        return { refused: `no tool ${edit.tool} in this loop (${tools.join(", ")})` };
      }
      const value = removedTools.includes(edit.tool) ? removedTools : [...removedTools, edit.tool];
      return [
        {
          jsonPath: [...loop.jsonPath, "locals", "removedTools"],
          value,
          applied: `removed ${edit.tool} from the next round`,
        },
      ];
    }
    case "setGuard": {
      const guard = resolveGuard(edit.guard, edit.branchPath, checkpoint, at);
      if (isRefusal(guard)) return guard;
      const name = guard.found.label ?? String("index" in edit.guard ? edit.guard.index : "");
      if (guard.found.root) {
        return { refused: `guard ${name} is the root budget; the host sets its ceiling` };
      }
      const copies: GuardCopy[] = guard.found.jsonPaths.map((jsonPath, index) => ({
        jsonPath,
        json: getAt(json, jsonPath) as Partial<GuardJSON>,
        owner: index === 0,
      }));
      return guardWrites(copies, { limit: edit.limit, disarmed: edit.disarmed });
    }
    case "setLocal":
    case "setArg": {
      const frame = resolveFrame(edit.frame, checkpoint, at);
      if (isRefusal(frame)) return frame;
      const field = edit.op === "setLocal" ? "locals" : "args";
      return [
        {
          jsonPath: [...frame.jsonPath, field, edit.name],
          value: edit.value,
          applied: `${edit.name} = ${JSON.stringify(edit.value)}`,
        },
      ];
    }
    case "setGlobal": {
      const store = resolveModule(edit.module, edit.branchPath, checkpoint, at);
      if (isRefusal(store)) return store;
      const module = store.jsonPath.at(-1);
      return [
        {
          jsonPath: [...store.jsonPath, edit.name],
          value: edit.value,
          applied: `${module}.${edit.name} = ${JSON.stringify(edit.value)}`,
        },
      ];
    }
    case "setBranchResult": {
      const branch = resolveBranch(edit.branch, checkpoint);
      if (isRefusal(branch)) return branch;
      if (branch.found.key.startsWith("tool_")) {
        return { refused: "a tool call's result is loop bookkeeping; see the spec's not goals" };
      }
      // A branch that stopped on an interrupt takes a result too: the
      // debugger's own stop is one, and `runBatch` skips a branch with a
      // result on resume, so the interrupt's answer is never read.
      return [
        {
          jsonPath: [...branch.jsonPath, "result"],
          value: { result: edit.value },
          applied: `branch ${branch.found.key} finished with ${JSON.stringify(edit.value)}`,
        },
      ];
    }
  }
}
