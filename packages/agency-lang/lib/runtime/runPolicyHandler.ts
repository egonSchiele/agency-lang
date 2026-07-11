import type { Policy, PolicyRule } from "./policy.js";
import { checkPolicy, validatePolicy } from "./policy.js";
import { approve, reject } from "./interrupts.js";
import type { HandlerFn } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  INTERACTIVE_ON,
} from "./runPolicyEnv.js";
import readline from "readline";

type Intr = { effect: string; message: string; data: any; origin: string };

export type PromptDecision =
  | "approve"
  | "reject"
  | "approve-always"
  | "reject-always";

export type PromptFn = (intr: Intr) => Promise<PromptDecision>;

// How each prompt decision resolves: the immediate action, and whether to
// remember a rule for the rest of the run. Declarative so the four branches
// don't each hand-roll the same array surgery.
const DECISIONS: Record<
  PromptDecision,
  { action: "approve" | "reject"; remember: boolean }
> = {
  approve: { action: "approve", remember: false },
  reject: { action: "reject", remember: false },
  "approve-always": { action: "approve", remember: true },
  "reject-always": { action: "reject", remember: true },
};

// Build the outermost policy handler for a CLI-driven run. `policy` is the
// base; interactive "always" decisions accumulate into a working clone so
// checkPolicy serves them without re-prompting.
export function makeRunPolicyHandler(
  policy: Policy,
  opts: { interactive: boolean; prompt: PromptFn },
): HandlerFn {
  const working: Policy = JSON.parse(JSON.stringify(policy));

  // Prepend a catch-all rule for `effect` so checkPolicy serves it first.
  const remember = (effect: string, action: PolicyRule["action"]): void => {
    working[effect] = [{ action }, ...(working[effect] ?? [])];
  };

  return async (intr: Intr) => {
    const decision = checkPolicy(working, intr);
    if (decision.type === "approve") return approve();
    if (decision.type === "reject") return reject();

    // Unmatched (checkPolicy fell through to "propagate").
    if (!opts.interactive) return reject();

    const outcome = DECISIONS[await opts.prompt(intr)];
    if (outcome.remember) remember(intr.effect, outcome.action);
    return outcome.action === "approve" ? approve() : reject();
  };
}

// Terminal prompt used by installRunPolicyHandler. Falls back to reject
// (fail-closed) when stdin is not a TTY rather than hanging. Exported so the
// non-TTY fallback is unit-testable.
export async function terminalPrompt(intr: Intr): Promise<PromptDecision> {
  if (!process.stdin.isTTY) return "reject";
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const dataStr = JSON.stringify(intr.data);
    const answer: string = await new Promise((resolve) =>
      rl.question(
        `\nInterrupt "${intr.effect}": ${intr.message}\n  ${dataStr}\n` +
          `(a)pprove / (r)eject / (aa) approve-always / (rr) reject-always: `,
        resolve,
      ),
    );
    const choice = answer.trim().toLowerCase();
    if (choice === "aa") return "approve-always";
    if (choice === "rr") return "reject-always";
    if (choice === "a") return "approve";
    return "reject";
  } finally {
    rl.close();
  }
}

// Install the root policy handler on `execCtx` when the run was launched
// with a policy. Skipped in IPC subprocesses: a std::agency::run child
// forwards its interrupts up to the root process's handler chain, so the
// policy must live at the root only. Called from BOTH the fresh-run entry
// (runNode) and the resume entry (respondToInterrupts) so the never-
// serialized root handler is re-installed on a resumed leg too.
export function installRunPolicyHandler(execCtx: {
  pushHandler: (h: HandlerFn) => void;
}): void {
  if (isIpcMode()) return;
  const raw = process.env[AGENCY_RUN_POLICY];
  if (!raw) return;

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

  const interactive = process.env[AGENCY_RUN_POLICY_INTERACTIVE] === INTERACTIVE_ON;
  const handler = makeRunPolicyHandler(policy as Policy, {
    interactive,
    prompt: terminalPrompt,
  });
  execCtx.pushHandler(handler);
}
