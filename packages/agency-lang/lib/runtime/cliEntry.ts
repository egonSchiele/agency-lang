import { readFileSync } from "node:fs";
import {
  AGENCY_ENTRY_NODE,
  AGENCY_RESUME_FILE,
  AGENCY_RESUME_FORCE,
  AGENCY_RESUME_OVERRIDES,
  EXIT_CODE_USAGE_ERROR,
} from "../constants.js";
import { verifyCheckpointChecksum } from "./checkpointChecksum.js";
import { exitProcessNow } from "./exitProcess.js";
import type { ResumeOverrides } from "./resumeSetup.js";
import { Checkpoint } from "./state/checkpointStore.js";
import { reportBudgetExceededAndExit } from "./budgetExit.js";
import { resolveCliInterrupts } from "./cliInterruptResolution.js";
import { flushPendingStatelogPosts } from "../statelogSender.js";

const DEFAULT_ENTRY_NODE = "main";

type CliEntryArgs<T> = {
  /** Every node the compiled file registered on its graph. */
  nodeNames: string[];
  /** Run one of those nodes from the top, as a fresh program. */
  startNode: (nodeName: string) => Promise<T>;
  resume: (checkpoint: Checkpoint, overrides: ResumeOverrides) => Promise<T>;
};

/** Start the node `agency run file.agency:node` named, or `main`. A name the
 *  file does not have is a usage error: print it and exit without the crash
 *  banner and stack trace a thrown error would get. */
function startEntryNode<T>(args: CliEntryArgs<T>): Promise<T> {
  const nodeName = process.env[AGENCY_ENTRY_NODE] || DEFAULT_ENTRY_NODE;
  if (!args.nodeNames.includes(nodeName)) {
    console.error(
      `This file has no node named "${nodeName}". Its nodes are: ${args.nodeNames.join(", ")}`,
    );
    // No node has started, so there are no logs to send.
    exitProcessNow(EXIT_CODE_USAGE_ERROR);
  }
  return args.startNode(nodeName);
}

function parseOverrides(raw: string | undefined): ResumeOverrides {
  if (!raw) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${AGENCY_RESUME_OVERRIDES} is not valid JSON: ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${AGENCY_RESUME_OVERRIDES} must be a JSON object`);
  }
  for (const bucket of ["locals", "args", "globals"] as const) {
    const value = (parsed as Record<string, unknown>)[bucket];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw new Error(`${AGENCY_RESUME_OVERRIDES}.${bucket} must be a JSON object`);
    }
    if (value && Object.prototype.hasOwnProperty.call(value, "__proto__")) {
      throw new Error(`${AGENCY_RESUME_OVERRIDES}.${bucket} contains an invalid variable name`);
    }
  }
  return parsed as ResumeOverrides;
}

export async function runCliEntry<T>(args: CliEntryArgs<T>): Promise<T> {
  const filename = process.env[AGENCY_RESUME_FILE];
  if (!filename) {
    return startEntryNode(args);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filename, "utf8"));
  } catch (error) {
    throw new Error(`Could not read checkpoint file "${filename}": ${String(error)}`);
  }

  const checkpoint = Checkpoint.fromJSON(raw);
  if (!checkpoint) {
    throw new Error(`Checkpoint file "${filename}" does not contain a valid Agency checkpoint`);
  }
  if (
    checkpoint.signature !== undefined &&
    process.env[AGENCY_RESUME_FORCE] !== "1" &&
    !verifyCheckpointChecksum(checkpoint)
  ) {
    throw new Error(`Checkpoint file "${filename}" failed checksum verification`);
  }
  return args.resume(checkpoint, parseOverrides(process.env[AGENCY_RESUME_OVERRIDES]));
}

type CliMainArgs = CliEntryArgs<any> & {
  /** The compiled file's `respondToInterrupts`, which resumes the run. */
  respondToInterrupts: Parameters<typeof resolveCliInterrupts>[1];
};

/**
 * Run a compiled file that was started directly, as `node file.js`.
 *
 * Generated code calls this without `await`. A generated file must have no
 * top-level `await`, because the build cannot rewrite the `async` functions
 * of a file that has one (see docs/dev/runtime/portable-context-spike.md).
 *
 * An error is rethrown after it is reported. Nothing awaits the returned
 * promise, so Node ends the process with a non-zero exit code.
 */
export async function runCliMain(args: CliMainArgs): Promise<void> {
  try {
    const result = await runCliEntry(args);
    // Interrupts that no handler settled have reached the user.
    // resolveCliInterrupts decides each one under a run policy, prompting
    // with --interactive and rejecting otherwise, then resumes. Without a
    // policy it reports the unhandled interrupt and exits non-zero.
    await resolveCliInterrupts(result, args.respondToInterrupts);
  } catch (error) {
    // A root budget trip (--max-cost/--max-time) exits 3 with its own
    // message and never returns. Every other error is a crash. User guard()
    // trips never reach here: _runGuarded converts them to Results.
    await reportBudgetExceededAndExit(error);
    console.error(`\nAgent crashed: ${(error as Error).message}`);
    // The throw below ends the process, which would kill any log requests
    // still on their way.
    await flushPendingStatelogPosts();
    throw error;
  }
}
