export type ModuleSourceEntry = {
  /** sha256 of the module's source text. */
  hash: string;
  /** ISO timestamp of when that source was compiled. */
  compiledAt: string;
};

// moduleId -> source entry for every loaded module. Populated by generated
// code at module init (like __toolRegistry); derived from loaded code, never
// serialized. Null-prototype: moduleIds are arbitrary strings.
const registry: Record<string, ModuleSourceEntry> = Object.create(null);

export function registerModuleSourceHash(moduleId: string, hash: string, compiledAt: string): void {
  registry[moduleId] = { hash, compiledAt };
}

export function getModuleSourceHash(moduleId: string): ModuleSourceEntry | undefined {
  return registry[moduleId];
}

/** Test-only: clear the registry between cases. */
export function __resetModuleSourceHashRegistry(): void {
  for (const moduleId of Object.keys(registry)) {
    delete registry[moduleId];
  }
}
