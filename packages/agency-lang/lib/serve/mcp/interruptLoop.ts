import { checkPolicy } from "../../runtime/policy.js";
import { resolvePolicyDirs } from "../../runtime/policyDirs.js";
import { defaultHost } from "#default-host";
import { approve, reject } from "../../runtime/interrupts.js";
import type { PolicyStore } from "../policyStore.js";

export type InterruptHandlers = {
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

function applyPolicy(
  interrupts: Array<{ effect: string; message: string; data: any; origin: string }>,
  policy: Record<string, any>,
) {
  const dirs = resolvePolicyDirs(defaultHost());
  return interrupts.map((interrupt) => {
    const decision = checkPolicy(policy, interrupt, dirs);
    if (decision.type === "approve") {
      return approve();
    }
    return reject(decision.type === "reject" ? decision.message : undefined);
  });
}

export async function runWithPolicy(
  invoke: () => Promise<unknown>,
  policyStore: PolicyStore,
  handlers: InterruptHandlers,
): Promise<unknown> {
  let result = await invoke();

  while (handlers.hasInterrupts(result)) {
    const interrupts = result as Array<{
      effect: string;
      message: string;
      data: any;
      origin: string;
    }>;
    const responses = applyPolicy(interrupts, policyStore.get());
    result = await handlers.respondToInterrupts(interrupts, responses);
  }

  return result;
}
