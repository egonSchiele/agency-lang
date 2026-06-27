import {
  _resolveModelName,
  _downloadModel,
  _listDownloadedModels,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _removeModel,
  hasLocalModelSupport,
} from "../stdlib/localModels.js";

const BYTES_PER_GB = 1e9;

function formatGB(bytes: number): string {
  return `${(bytes / BYTES_PER_GB).toFixed(2)} GB`;
}

/** Install-gate for I/O commands. Honors the AGENCY_LLAMA_PROVIDER_MODULE
 *  override the same way `requireSupport()` in `localModels.ts` does — a
 *  caller who supplies their own provider module doesn't need
 *  smoltalk-llama-cpp resolvable, and we shouldn't block them. */
function gate(): void {
  if (!hasLocalModelSupport()) {
    console.error("Local models need smoltalk-llama-cpp — run: npm i -g smoltalk-llama-cpp");
    process.exit(1);
  }
}

// Test-facing helpers: take an optional `file` so the unit tests don't have
// to mutate process.cwd(). Production CLI wiring passes `undefined`,
// which the underlying functions resolve via the walk-up rule.
export function aliasList(file?: string) {
  return _listModelNames(file ?? "");
}

export function aliasAdd(name: string, uri: string, file?: string): string {
  const written = _aliasModel(name, uri, file ?? "");
  console.log(`Aliased "${name}" → ${uri} in ${written}`);
  return written;
}

export function aliasRemove(name: string, file?: string): string {
  const { file: inspected, removed } = _unaliasModel(name, file ?? "");
  if (removed) {
    console.log(`Removed alias "${name}" from ${inspected}`);
  } else {
    console.log(`Alias "${name}" not present in ${inspected}; nothing changed`);
  }
  return inspected;
}

export function runList(): void {
  gate();
  const models = _listDownloadedModels();
  if (models.length === 0) {
    console.log("No models downloaded.");
    return;
  }
  for (const m of models) {
    console.log(`${m.name}\t${formatGB(m.sizeBytes)}`);
  }
  const total = models.reduce((sum, m) => sum + m.sizeBytes, 0);
  console.log(`Total: ${formatGB(total)}`);
}

export async function runDownload(value: string): Promise<void> {
  gate();
  console.log(await _downloadModel(value));
}

export function runRemove(name: string): void {
  gate();
  const removed = _removeModel(name);
  console.log(removed ? `Removed ${name}` : `Not found: ${name}`);
}

export function runResolve(value: string): void {
  console.log(_resolveModelName(value));
}

export function runAliasList(): void {
  // Curated entries show name, params, category, size, and description.
  // User aliases show only what they have (name + target).
  for (const m of _listModelNames()) {
    if (m.source === "curated") {
      const size = m.sizeBytes ? formatGB(m.sizeBytes) : "?";
      console.log(`${m.name}\t${m.params}\t${m.category}\t${size}\t${m.description}`);
    } else {
      console.log(`${m.name}\t${m.target}\t(alias)`);
    }
  }
}

export function runAliasAdd(name: string, uri: string): void {
  aliasAdd(name, uri);
}

export function runAliasRemove(name: string): void {
  aliasRemove(name);
}
