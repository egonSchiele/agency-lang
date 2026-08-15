// Terminal prompt mechanics for deciding a surfaced interrupt, in a leaf that
// imports only the response API (interruptResponse.ts), never the runtime
// interrupt machinery. This keeps the runtime dependency graph one-way:
// interruptResponse ◀ interruptPrompts ◀ interruptResolution, with
// runPolicyHandler also depending on this leaf. runPolicyHandler re-exports
// these names so existing imports keep resolving.

import readline from "readline";
import { color } from "@/utils/termcolors.js";
import { approve, reject } from "./interruptResponse.js";
import type { InterruptResponse } from "./interruptResponse.js";

/** The interrupt fields a prompt reads. A full runtime `Interrupt` satisfies it. */
export type Intr = {
  effect: string;
  message: string;
  data: any;
  origin: string;
  expectsValue?: boolean;
};

export type PromptDecision = "approve" | "reject" | "approve-always" | "reject-always";

export type PromptFn = (intr: Intr) => Promise<PromptDecision>;

// Prompt for a value-expecting interrupt (`const x = raise …`): returns the
// full response (approve carries the typed answer) rather than a decision.
export type ValuePromptFn = (intr: Intr) => Promise<InterruptResponse>;

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

// Terminal approve/reject prompt used by the endpoint resolver. Falls back to
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
    parseValueAnswer(await askLine(formatInterruptPrompt(intr) + `answer (empty line rejects): `)),
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
  const lines = ["", color.cyan(intr.effect), color.cyan(rule), "", color.bold(intr.message)];
  const hasData =
    intr.data != null && !(typeof intr.data === "object" && Object.keys(intr.data).length === 0);
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
