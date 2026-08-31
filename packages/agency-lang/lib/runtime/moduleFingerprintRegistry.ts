import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type ModuleFingerprint = {
  /** sha256 of the module's generated code (computed at compile time, before
   *  the registration statement itself is appended). */
  hash: string;
  /** ISO timestamp of when the compiled artifact was written, or "unknown". */
  compiledAt: string;
};

// moduleId -> fingerprint for every loaded module. Populated by generated
// code at module init (like __toolRegistry); derived from loaded code, never
// serialized. Null-prototype: moduleIds are arbitrary strings.
const registry: Record<string, ModuleFingerprint> = Object.create(null);

/** Called from generated code with the module's own `import.meta.url`; the
 *  artifact's mtime becomes the "compiled at" time, so the emitted bytes stay
 *  deterministic (no per-compile timestamp in the output). */
export function registerModuleFingerprint(
  moduleId: string,
  hash: string,
  artifactUrl: string,
): void {
  registry[moduleId] = { hash, compiledAt: artifactMtime(artifactUrl) };
}

function artifactMtime(artifactUrl: string): string {
  try {
    return statSync(fileURLToPath(artifactUrl)).mtime.toISOString();
  } catch (e) {
    // A non-file URL or a vanished artifact still registers; only the
    // timestamp in the refusal message degrades.
    return "unknown";
  }
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
