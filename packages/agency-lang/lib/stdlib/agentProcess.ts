// What this process can do for the agent's session program. A front-end
// sets these once, when it starts. They describe the process, so they are
// not saved with a session: whichever process resumes one answers for
// itself.

let localModels = true;

/** Say whether this process can host a local model. A terminal can. An
 *  app whose one process holds every session cannot. */
export function _setLocalModelsAllowed(allowed: boolean): void {
  localModels = allowed;
}

export function _localModelsAllowed(): boolean {
  return localModels;
}

let manySessions = false;

/** Say that this process holds many sessions at once, as an app's engine
 *  does. The agent then keeps nothing in the process for one session that
 *  another could read: each read of a folder's commands and skills is a
 *  scan that session's own policy is asked about. A terminal runs one
 *  session and leaves this off. */
export function _setManySessions(many: boolean): void {
  manySessions = many;
}

export function _holdsManySessions(): boolean {
  return manySessions;
}

/** What the process shows of the agent's work, and whether a person is at
 *  it. A front-end sets these once. The shell run and the session run each
 *  have their own copy of a module's globals, so these live here, where
 *  both runs read the same values. */
export type TraceOptions = {
  debug: boolean;
  verbose: boolean;
  interactive: boolean;
};

let traceOptions: TraceOptions = {
  debug: false,
  verbose: false,
  interactive: true,
};

export function _setTraceOptions({ debug, verbose, interactive }: TraceOptions): void {
  traceOptions = { debug, verbose, interactive };
}

export function _traceOptions(): TraceOptions {
  return { ...traceOptions };
}
