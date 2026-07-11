import type { Policy } from "./policy.js";
import { checkPolicyExplicit, validatePolicy } from "./policy.js";
import {
  approve,
  reject,
  hasInterrupts,
  reportUnhandledInterrupts,
} from "./interrupts.js";
import type { Interrupt, InterruptResponse } from "./interrupts.js";
import type { HandlerFn, RunNodeResult } from "./types.js";
import { isIpcMode } from "./subprocessRunInfo.js";
import {
  AGENCY_RUN_POLICY,
  AGENCY_RUN_POLICY_INTERACTIVE,
  AGENCY_RUN_POLICY_INTERACTIVE_ON,
} from "@/constants.js";
import readline from "readline";
import { color } from "@/utils/termcolors.js";

type Intr = {
  effect: string;
  message: string;
  data: any;
  origin: string;
  expectsValue?: boolean;
};

export type PromptDecision =
  | "approve"
  | "reject"
  | "approve-always"
  | "reject-always";

export type PromptFn = (intr: Intr) => Promise<PromptDecision>;

// Prompt for a value-expecting interrupt (`const x = raise …`): returns the
// full response (approve carries the typed answer) rather than a decision.
export type ValuePromptFn = (intr: Intr) => Promise<InterruptResponse>;

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

// Map a raw terminal answer to a decision. Accepts the short forms shown in the
// prompt (a / r / aa / rr) and the spelled-out words; anything unrecognized is a
// safe reject (fail-closed). Pure and exported so the four cases are unit-tested
// without readline plumbing.
export function parsePromptAnswer(raw: string): PromptDecision {
  const choice = raw.trim().toLowerCase();
  if (choice === "aa" || choice === "approve-always") return "approve-always";
  if (choice === "rr" || choice === "reject-always") return "reject-always";
  if (choice === "a" || choice === "approve") return "approve";
  return "reject";
}

// Terminal prompts share ONE physical stdin, so concurrent interrupts (fork /
// race raising several at once) must be surfaced one at a time — two readline
// interfaces reading the same stdin would interleave and clobber each other.
// This process-global chain queues prompts so the user answers them in
// sequence. Process-global is correct here: it guards the terminal itself, not
// per-run state.
let promptQueue: Promise<unknown> = Promise.resolve();

// Serialize a prompt through the terminal queue (see promptQueue above).
function queuePrompt<T>(fn: () => Promise<T>): Promise<T> {
  const run = promptQueue.then(fn);
  // Keep the chain alive whether or not this prompt resolves cleanly.
  promptQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Terminal approve/reject prompt used by resolveCliInterrupts. Falls back to
// reject (fail-closed) when stdin is not a TTY rather than hanging. Exported
// so the non-TTY fallback is unit-testable.
export async function terminalPrompt(intr: Intr): Promise<PromptDecision> {
  if (!process.stdin.isTTY) return "reject";
  return queuePrompt(async () =>
    parsePromptAnswer(
      await askLine(
        formatInterruptPrompt(intr) +
          `(a)pprove / (r)eject / (aa) approve-always / (rr) reject-always: `,
      ),
    ),
  );
}

// Terminal prompt for a value-expecting interrupt: the interrupt message IS
// the question, and the typed line becomes the approval value. Same non-TTY
// fail-closed contract as terminalPrompt.
export async function terminalValuePrompt(intr: Intr): Promise<InterruptResponse> {
  if (!process.stdin.isTTY) return reject();
  return queuePrompt(async () =>
    parseValueAnswer(
      await askLine(formatInterruptPrompt(intr) + `answer (empty line rejects): `),
    ),
  );
}

// Map a typed line to a response for a value-expecting interrupt: the text is
// the approval value verbatim; an empty/whitespace-only line (including stdin
// EOF, which askLine surfaces as "") rejects. Pure and exported for tests.
export function parseValueAnswer(raw: string): InterruptResponse {
  return raw.trim() === "" ? reject() : approve(raw);
}

// Render the interrupt banner shown above the approve/reject question:
// effect name over a horizontal rule (both cyan), then the message in bold,
// then the interrupt's data pretty-printed — omitted entirely when there is
// none (null/undefined or an empty object). Exported for unit tests.
export function formatInterruptPrompt(intr: Intr): string {
  const rule = "─".repeat(Math.max(intr.effect.length, 36));
  const lines = [
    "",
    color.cyan(intr.effect),
    color.cyan(rule),
    "",
    color.bold(intr.message),
  ];
  const hasData =
    intr.data != null &&
    !(typeof intr.data === "object" && Object.keys(intr.data).length === 0);
  if (hasData) {
    // Best-effort: interrupt data is program-controlled and may not be
    // serializable (circular references, BigInt). The prompt must still
    // render — a throw here would crash the run right as it asks for a
    // decision.
    try {
      lines.push(JSON.stringify(intr.data, null, 2));
    } catch {
      lines.push(String(intr.data));
    }
  }
  lines.push("");
  return lines.join("\n");
}

// Ask one question on the terminal and return the typed line. Stdin EOF (^D,
// or a closed pipe) while the question is pending would otherwise leave the
// promise unsettled forever — the process would die with an "unsettled
// top-level await" instead of a decision — so it resolves to "" (which every
// caller parses to a safe reject).
async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await new Promise((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(question, resolve);
    });
  } finally {
    rl.close();
  }
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
  const policy = loadEnvPolicy();
  if (!policy) return;
  execCtx.pushHandler(makeRunPolicyHandler(policy));
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
