// `agency agent`'s session, saved from its REPL. The agent is one run: the
// REPL calls a turn, and after each line this file saves a checkpoint of
// the run where a later `--resume` finds it. A turn that stops on an
// approval no rule decides is saved too, and picked up from that
// checkpoint with the person asked. See docs/dev/agents/agent-sessions.md.
import { isAborted } from "../runtime/abortedResult.js";
import { currentRun, type Run } from "../runtime/asyncContext.js";
import { __call } from "../runtime/call.js";
import { checkpointFor, getCheckpointFor } from "../runtime/checkpoint.js";
import { hasInterrupts } from "../runtime/interrupts.js";
import { getModuleFingerprint } from "../runtime/moduleFingerprintRegistry.js";
import { processSlot } from "../runtime/processSlot.js";
import { Checkpoint } from "../runtime/state/checkpointStore.js";
import { _saveSession, reportHerdrSession, type SessionRecord } from "./agentSessions.js";
import { printAgentTrace } from "./agentToolTrace.js";
import { _setReplResubmit } from "./cli.js";
import { _setDefersUndecided } from "./policy.js";

type SaveTarget = { dir: string; record: SessionRecord } | null;

/** The agent's Agency functions the REPL's submit wraps. */
type Hooks = {
  /** Runs one submitted line. False ends the REPL. */
  onSubmit: unknown;
  /** After a line that ran to its end: where to save, or null. */
  afterLine: unknown;
  /** While a line waits on an approval: where to save, or null. */
  whileWaiting: unknown;
};

// Everything here has to outlast a checkpoint restore, so none of it is
// Agency state. A closure built by an Agency statement would be a finished
// step in the checkpoint, and come back from a restore as nothing.
type ReplSession = {
  hooks: Hooks | null;
  /** The checkpoint of a line that stopped on an approval, for the agent
   *  to restore once the REPL has ended. */
  toRestore: unknown;
  /** The next submit picks up a saved line, so the person is asked. */
  pickingUp: boolean;
};

const session = processSlot<ReplSession>("agency.agentReplSession", () => ({
  hooks: null,
  toRestore: null,
  pickingUp: false,
}));

/** Installed from the agent's `main` before any restore. */
export function _installSessionHooks(
  onSubmit: unknown,
  afterLine: unknown,
  whileWaiting: unknown,
): void {
  session.set({ ...session.get(), hooks: { onSubmit, afterLine, whileWaiting } });
}

function call(run: Run, fn: unknown, ...args: unknown[]): Promise<unknown> {
  return __call(run, fn, { type: "positional", args });
}

async function save(run: Run, target: SaveTarget, checkpoint: unknown): Promise<void> {
  if (!target) return;
  const error = await _saveSession(target.dir, target.record, checkpoint);
  if (error) {
    printAgentTrace(run.ctx.host, { kind: "sessionSaveFailure", message: error });
  } else {
    reportHerdrSession(target.record.id);
  }
}

/**
 * The REPL's `onSubmit` for the agent.
 *
 * A line that runs to its end is saved once its Agency frames have
 * returned, so the checkpoint is "the REPL waiting at its prompt". A
 * checkpoint taken inside the line would carry the line's own frame.
 *
 * While the line runs, an approval no rule decides is left unanswered. The
 * line then stops and comes back as its interrupts, the first of which
 * carries a checkpoint of the run at the approval. That checkpoint is
 * saved, the REPL is ended, and the agent restores it
 * (`_takeCheckpointToRestore`). The REPL starts again and submits once
 * more without reading a line, which picks the line up where it stopped,
 * this time with the person asked.
 */
export async function _sessionOnSubmit(line: string): Promise<unknown> {
  const run = currentRun();
  const state = session.get();
  if (!state.hooks) throw new Error("_installSessionHooks was not called");
  const { hooks } = state;
  const pickingUp = state.pickingUp;
  session.set({ ...state, pickingUp: false });

  let reply: unknown;
  _setDefersUndecided(!pickingUp);
  try {
    reply = await call(run, hooks.onSubmit, line);
  } finally {
    // Outside a submitted line the handler asks, as it does at startup.
    _setDefersUndecided(false);
  }
  // A cancelled line (Esc) comes back as a value. It is thrown on, as the
  // error the REPL reports as "cancelled", and nothing is saved for it.
  if (isAborted(reply)) throw reply.toError();
  // False ends the REPL.
  if (reply === false) return reply;
  if (hasInterrupts(reply)) {
    // The person was asked, and the line still stopped: the REPL says so.
    // Restoring again would ask the same thing forever.
    if (pickingUp) return reply;
    const checkpoint: unknown = reply[0].checkpoint;
    if (checkpoint === undefined) return reply;
    await save(run, (await call(run, hooks.whileWaiting)) as SaveTarget, checkpoint);
    session.set({ ...session.get(), toRestore: checkpoint, pickingUp: true });
    _setReplResubmit(line);
    return false;
  }
  const target = (await call(run, hooks.afterLine, line)) as SaveTarget;
  if (target) {
    await save(run, target, getCheckpointFor(run, await checkpointFor(run)));
  }
  return reply;
}

/** The checkpoint of a line that stopped on an approval, once, or null.
 *  The agent reads it when its REPL ends, and restores it. */
export function _takeCheckpointToRestore(): unknown {
  const state = session.get();
  session.set({ ...state, toRestore: null });
  if (state.toRestore !== null) {
    // The restore that follows is paced by a person's answer, so it is not
    // counted against the cap that stops a restore loop. A long sitting
    // asks about more approvals than the cap allows restores.
    currentRun().ctx._nextRestoreUncounted = true;
  }
  return state.toRestore;
}

/** For a resume in a new process, before the restore: the REPL's first
 *  submit asks the person. A session saved at an approval is picked up by
 *  it. One saved at the prompt gets an empty line, which does nothing. */
export function _pickUpOnResume(): void {
  session.set({ ...session.get(), pickingUp: true });
  _setReplResubmit("");
}

/** Whether the code loaded now can go on from a saved checkpoint. A
 *  checkpoint records a hash of the generated code of each module it is
 *  paused in, and the runtime refuses to restore when one differs. This is
 *  the same comparison, made before the saved conversation is printed. */
export function _checkpointFitsThisCode(checkpoint: unknown): boolean {
  const fingerprints = Checkpoint.fromJSON(checkpoint)?.moduleFingerprints ?? {};
  return Object.entries(fingerprints).every(([moduleId, saved]) => {
    const now = getModuleFingerprint(moduleId)?.hash;
    return now === undefined || now === saved.hash;
  });
}
