import type { Policy } from "./policy.js";
import { checkPolicyExplicit, validatePolicy } from "./policy.js";
import { approve, reject } from "./interruptResponse.js";
import { hasInterrupts, reportUnhandledInterrupts } from "./interrupts.js";
import type { Interrupt, InterruptResponse } from "./interrupts.js";
import type { HandlerFn, RunNodeResult } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";
import {
  terminalPrompt,
  terminalValuePrompt,
} from "./interruptPrompts.js";
import type { Intr, PromptDecision, PromptFn, ValuePromptFn } from "./interruptPrompts.js";

// The terminal prompt mechanics now live in the cycle-free interruptPrompts
// leaf. Re-export them so existing `… from "./runPolicyHandler.js"` imports and
// tests keep resolving.
export {
  parsePromptAnswer,
  parseValueAnswer,
  formatInterruptPrompt,
  terminalPrompt,
  terminalValuePrompt,
} from "./interruptPrompts.js";
export type { PromptDecision, PromptFn, ValuePromptFn } from "./interruptPrompts.js";

// How each prompt decision resolves: the immediate action, and whether to
// remember it for the rest of the run.
const DECISIONS: Record<
  PromptDecision,
  { action: "approve" | "reject"; remember: boolean }
> = {
  approve: { action: "approve", remember: false },
  reject: { action: "reject", remember: false },
  "approve-always": { action: "approve", remember: true },
  "reject-always": { action: "reject", remember: true },
};

// Build the root policy handler for a CLI-driven run. It participates in the
// handler chain like any other handler — but ONLY for effects the policy
// explicitly matches. Effects the policy never mentions get no response, so
// the chain resolves by the program's own handlers; what nothing settles
// surfaces to the user endpoint (resolveCliInterrupts) instead of being
// decided here.
export function makeRunPolicyHandler(policy: Policy): HandlerFn {
  return async (intr: Intr) => {
    const decision = checkPolicyExplicit(policy, intr);
    if (decision === null) return undefined;
    if (decision.type === "approve") return approve();
    if (decision.type === "reject") return reject();
    // An explicit `propagate` rule: force the interrupt to the user.
    return { type: "propagate" };
  };
}

// Parse and validate the run policy from the environment. Returns null when
// no policy was passed (the run was launched without any policy flag).
function loadEnvPolicy(): Policy | null {
  const raw = process.env[AGENCY_RUN_POLICY];
  if (!raw) return null;

  let policy: unknown;
  try {
    policy = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${AGENCY_RUN_POLICY} is not valid JSON: ${String(e)}`);
  }
  const valid = validatePolicy(policy);
  if (!valid.success) {
    throw new Error(`${AGENCY_RUN_POLICY} is not a valid policy: ${valid.error}`);
  }
  return policy as Policy;
}

// Whether the run was launched with any interrupt-handling mechanism (a
// --policy / --approve / --reject / --interactive flag all set AGENCY_RUN_POLICY).
// The declarative environment boundary the CLI endpoint adapter checks before
// falling back to reporting an unhandled interrupt.
export function hasRunPolicyMechanism(): boolean {
  return loadEnvPolicy() !== null;
}

// Install the root policy handler on `execCtx` when the run was launched
// with a policy. Skipped in IPC subprocesses: a std::agency::run child
// forwards its interrupts up to the root process's handler chain, so the
// policy must live at the root only. Called from BOTH the fresh-run entry
// (runNode) and the resume entry (respondToInterrupts) so the never-
// serialized root handler is re-installed on a resumed leg too.
export function installRunPolicyHandler(execCtx: {
  pushHandler: (h: HandlerFn, liveGuardIds: string[]) => void;
}): void {
  if (isIpcMode()) return;
  const policy = loadEnvPolicy();
  if (!policy) return;
  // liveGuardIds: [] — explicit: the --policy handler registers at run
  // start, before any guard exists, and it is the outermost supervisory
  // layer; a policy answering an interrupt is never metered or gated by
  // user guards.
  execCtx.pushHandler(makeRunPolicyHandler(policy), []);
}

// The user endpoint for a CLI-driven run: called by the generated bootstrap
// after the top-level node returns. The handler chain has already had its
// say — anything still in `result.data` is an interrupt the program's own
// handlers (and the policy's explicit rules) did NOT settle, i.e. it has
// surfaced to the user. This loop plays the role that a TypeScript caller
// would: decide each interrupt, then resume via `respond` (the module-bound
// respondToInterrupts) until the run finishes.
//
// Decisions: `--interactive` prompts on the terminal ("always" answers are
// remembered for the rest of the run); without it every surfaced interrupt
// is rejected (the documented default). Value-expecting interrupts
// (`const x = raise …`, expectsValue) get the answer prompt instead — the
// typed line becomes the approval value — and skip the remembered map both
// ways: a standing approve/reject can't answer a question, and answering a
// question shouldn't create a standing rule. Without any policy flag at all,
// this falls back to reportUnhandledInterrupts — print the handlers-guide
// message and exit non-zero, exactly the historical no-flag behavior.
export async function resolveCliInterrupts(
  result: RunNodeResult<any>,
  respond: (
    interrupts: Interrupt[],
    responses: InterruptResponse[],
  ) => Promise<RunNodeResult<any>>,
  opts?: { prompt?: PromptFn; valuePrompt?: ValuePromptFn },
): Promise<RunNodeResult<any>> {
  if (!hasInterrupts(result.data)) return result;
  // No policy flag (or an IPC subprocess, which never owns the terminal):
  // preserve the historical behavior — report and exit(1).
  if (isIpcMode() || !loadEnvPolicy()) {
    reportUnhandledInterrupts(result);
    return result;
  }

  const interactive =
    process.env[AGENCY_RUN_POLICY_INTERACTIVE] === AGENCY_RUN_POLICY_INTERACTIVE_ON;
  const prompt = opts?.prompt ?? terminalPrompt;
  const valuePrompt = opts?.valuePrompt ?? terminalValuePrompt;
  // Standing user decisions from "(aa)/(rr)" answers, keyed by effect.
  // Null-prototype so a program-controlled effect name (e.g. "__proto__")
  // is just an ordinary string key.
  const remembered: Record<string, "approve" | "reject"> =
    Object.create(null);

  while (hasInterrupts(result.data)) {
    const interrupts: Interrupt[] = result.data;
    const responses: InterruptResponse[] = [];
    for (const intr of interrupts) {
      if (intr.expectsValue) {
        responses.push(interactive ? await valuePrompt(intr) : reject());
        continue;
      }
      let action = remembered[intr.effect];
      if (!action && interactive) {
        const outcome = DECISIONS[await prompt(intr)];
        if (outcome.remember) remembered[intr.effect] = outcome.action;
        action = outcome.action;
      }
      // Non-interactive (or fail-closed): reject what would have surfaced.
      responses.push(action === "approve" ? approve() : reject());
    }
    result = await respond(interrupts, responses);
  }
  return result;
}
