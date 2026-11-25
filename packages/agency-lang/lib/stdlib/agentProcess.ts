// What this process can do for the agent's sessions. A front-end sets
// these once, when it starts. They describe the process, so they are
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
