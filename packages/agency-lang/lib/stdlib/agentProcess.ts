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
