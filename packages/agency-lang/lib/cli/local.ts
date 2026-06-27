import {
  _resolveModelName,
  _downloadModel,
  _listDownloadedModels,
  _listModelNames,
  _aliasModel,
  _unaliasModel,
  _removeModel,
  hasLocalModelSupport,
  formatGB,
  formatModelCatalog,
} from "../stdlib/localModels.js";

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
  // Show the source it resolved to (the hf: URI for a name/alias) and the
  // local path it landed at. For a .gguf-path input the two are the same, so
  // the source line is skipped.
  const source = _resolveModelName(value);
  const modelPath = await _downloadModel(value);
  if (source !== modelPath) {
    console.log(`source: ${source}`);
  }
  console.log(`model:  ${modelPath}`);
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
  // Aligned-table catalog (curated models + your aliases). The formatting
  // lives in localModels.ts so the agent's bare `--local-model` output and
  // this command render identically.
  console.log(formatModelCatalog());
}

export function runAliasAdd(name: string, uri: string): void {
  aliasAdd(name, uri);
}

export function runAliasRemove(name: string): void {
  aliasRemove(name);
}
