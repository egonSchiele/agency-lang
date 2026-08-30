import type { Policy } from "./policy.js";
import { checkPolicyExplicit, validatePolicy } from "./policy.js";
import { approve, reject } from "./interruptResponse.js";
import type { HandlerFn } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import { AGENCY_RUN_POLICY } from "@/constants.js";
import type { Intr } from "./interruptPrompts.js";

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

// Install the root policy handler on `execCtx` when the run carries a
// policy: the explicit one (a serve host's `InvocationOptions.policy`,
// validated by resolveInvocation) or, when none was passed, the
// AGENCY_RUN_POLICY environment policy the CLI flags set. An explicit
// policy replaces the env policy for the run.
// Skipped in IPC subprocesses: a std::agency::run child forwards its
// interrupts up to the root process's handler chain, so the policy must
// live at the root only. Called from BOTH the fresh-run entry (runNode)
// and the resume entry (respondToInterrupts) so the never-serialized root
// handler is re-installed on a resumed leg too.
export function installRunPolicyHandler(
  execCtx: {
    pushHandler: (h: HandlerFn, liveGuardIds: string[]) => void;
  },
  policy?: Policy,
): void {
  if (isIpcMode()) return;
  const effective = policy ?? loadEnvPolicy();
  if (!effective) return;
  // liveGuardIds: [] — explicit: the --policy handler registers at run
  // start, before any guard exists, and it is the outermost supervisory
  // layer; a policy answering an interrupt is never metered or gated by
  // user guards.
  execCtx.pushHandler(makeRunPolicyHandler(effective), []);
}

// The CLI-driven run's user endpoint (`resolveCliInterrupts`) lives in
// cliInterruptResolution.ts, above this module and the shared interrupt core,
// so nothing here imports it — keeping the runtime graph one-way.
