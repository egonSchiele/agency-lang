// A process-global map of moduleId -> sha256 of that module's source, populated
// at module init by generated code (like __toolRegistry). NOT serialized: it is
// derived from the loaded code and rebuilt whenever code loads. This is
// per-loaded-code state, not per-run state, so a module-level map is the
// correct owner (the GlobalStore rule is about per-run state).
const registry: Record<string, string> = {};

export function registerModuleSourceHash(moduleId: string, hash: string): void {
  registry[moduleId] = hash;
}

export function getModuleSourceHash(moduleId: string): string | undefined {
  return registry[moduleId];
}

/** Test-only: clear the registry between cases. */
export function __resetModuleSourceHashRegistry(): void {
  for (const moduleId of Object.keys(registry)) {
    delete registry[moduleId];
  }
}
