import { checkPolicy } from "../../runtime/policy.js";
import { approve, reject } from "../../runtime/interrupts.js";
import type { PolicyStore } from "../policyStore.js";

export type InterruptHandlers = {
  hasInterrupts: (data: unknown) => boolean;
  respondToInterrupts: (interrupts: unknown[], responses: unknown[]) => Promise<unknown>;
};

function applyPolicy(
  interrupts: Array<{ kind: string; message: string; data: any; origin: string }>,
  policy: Record<string, any>,
) {
  return interrupts.map((interrupt) => {
    const decision = checkPolicy(policy, interrupt);
    return decision.type === "approve" ? approve() : reject();
  });
}

export async function runWithPolicy(
  invoke: () => Promise<unknown>,
  policyStore: PolicyStore,
  handlers: InterruptHandlers,
): Promise<unknown> {
  let result = await invoke();

  while (handlers.hasInterrupts(result)) {
    const interrupts = result as Array<{ kind: string; message: string; data: any; origin: string }>;
    const responses = applyPolicy(interrupts, policyStore.get());
    result = await handlers.respondToInterrupts(interrupts, responses);
  }

  return result;
}
