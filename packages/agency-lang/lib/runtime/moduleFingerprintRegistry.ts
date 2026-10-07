export type ModuleFingerprint = {
  /** sha256 of the module's generated code (computed at compile time, before
   *  the registration statement itself is appended). */
  hash: string;
};

// moduleId -> fingerprint for every loaded module. Populated by generated
// code at module init (like __toolRegistry); derived from loaded code, never
// serialized. Null-prototype: moduleIds are arbitrary strings.
const registry: Record<string, ModuleFingerprint> = Object.create(null);

/** Called from generated code as the module's last statement. */
export function registerModuleFingerprint(moduleId: string, hash: string): void {
  registry[moduleId] = { hash };
}

export function getModuleFingerprint(moduleId: string): ModuleFingerprint | undefined {
  return registry[moduleId];
}

/** Test-only: clear the registry between cases. */
export function __resetModuleFingerprintRegistry(): void {
  for (const moduleId of Object.keys(registry)) {
    delete registry[moduleId];
  }
}
