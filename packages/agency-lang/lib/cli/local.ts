import prompts from "prompts";
import {
  _resolveModelName,
  _downloadModel,
  _listDownloadedModels,
  _listModelNames,
  _modelsCacheDir,
  _aliasModel,
  _unaliasModel,
  _removeModel,
  hasLocalModelSupport,
  formatGB,
  formatModelCatalog,
  formatLocalList,
  _refreshCatalog,
  type ModelNameEntry,
  type RefreshResult,
} from "../stdlib/localModels.js";
import { readDownloadManifest } from "../stdlib/localModelManifest.js";
import { ttyColor } from "../utils/termcolors.js";

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

/** Deliberately ungated: browsing the catalog needs no provider package
 *  (only download/remove do), and the pre-install experience — see what is
 *  available, then get told what to install — is the point. */
export function runList(long: boolean = false): void {
  const dir = _modelsCacheDir();
  console.log(
    formatLocalList({
      dir,
      entries: _listModelNames(),
      manifest: readDownloadManifest(dir),
      files: _listDownloadedModels(),
      long,
    }),
  );
}

export const CUSTOM_CHOICE = "__custom__";

/** Picker rows for the no-argument `agency local download`. Metadata-less
 *  aliases get a bare name; the trailing choice lets the user type an hf: URI
 *  or .gguf path. */
export function downloadChoices(
  entries: ModelNameEntry[],
): { title: string; value: string }[] {
  const rows = entries.map((e) => ({
    title:
      e.params !== undefined && e.sizeBytes !== undefined
        ? `${e.name}  (${e.params}, ${formatGB(e.sizeBytes)})`
        : e.name,
    value: e.name,
  }));
  return [...rows, { title: "custom (hf: URI or .gguf path)…", value: CUSTOM_CHOICE }];
}

export async function runDownload(value?: string): Promise<void> {
  gate();
  let picked = value;
  if (picked === undefined) {
    // Prompting needs BOTH ends of the terminal: a TTY stdout to draw on and
    // a TTY stdin to read from (`agency local download < /dev/null` from a
    // terminal has a TTY stdout but nothing to read).
    if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      // A script that reaches this point asked for a download and did not
      // get one — print what is available and fail.
      console.log(formatModelCatalog());
      console.error("Pass a model: agency local download <name>");
      process.exit(1);
    }
    const answer = await prompts({
      type: "select",
      name: "model",
      message: "Which model do you want to download?",
      choices: downloadChoices(_listModelNames()),
    });
    // Cancellation can surface as a missing key or as null — treat both as
    // "exit 0, nothing downloaded".
    if (answer.model == null) return;
    picked = answer.model as string;
    if (picked === CUSTOM_CHOICE) {
      const custom = await prompts({
        type: "text",
        name: "value",
        message: "hf: URI or .gguf path:",
      });
      if (custom.value == null || custom.value === "") return;
      picked = custom.value as string;
    }
  }
  // Show the source it resolved to (the hf: URI for a name/alias) and the
  // local path it landed at. For a .gguf-path input the two are the same, so
  // the source line is skipped.
  const source = _resolveModelName(picked);
  const modelPath = await _downloadModel(picked);
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

/** Format the lines `runRefresh` prints. Pure so it can be unit-tested without
 *  a network call. `r.modelCount` is the size of the catalog blob; the
 *  breakdown line accounts for every entry exactly once (added + updated +
 *  unchanged + skipped = modelCount). Color is applied via `ttyColor`, which
 *  is a no-op when stdout isn't a TTY — so piped output (and these unit tests)
 *  stay plain. */
export function formatRefreshOutput(r: RefreshResult): string[] {
  const lines: string[] = [];
  for (const s of r.skipped) {
    lines.push(`Skipped ${ttyColor.yellow(`"${s.name}"`)}: kept your alias (${ttyColor.dim(s.keptUri)});`);
    lines.push(`  remote would have set ${ttyColor.dim(s.remoteUri)}`);
  }
  lines.push(
    `Refreshed ${ttyColor.bold(String(r.modelCount))} models from ` +
      `${ttyColor.cyan(r.url)} → ${ttyColor.cyan(r.file)}`,
  );
  lines.push(
    `  (${ttyColor.green(`${r.added.length} added`)}, ${r.updated.length} updated, ` +
      `${r.unchanged.length} unchanged, ${ttyColor.red(`${r.removed.length} removed`)}, ` +
      `${ttyColor.yellow(`${r.skipped.length} skipped`)})`,
  );
  return lines;
}

export async function runRefresh(url?: string): Promise<void> {
  let result: RefreshResult;
  try {
    result = await _refreshCatalog({ url: url ?? "" });
  } catch (err) {
    console.error(`Refresh failed: ${(err as Error).message}`);
    process.exit(1);
  }
  for (const line of formatRefreshOutput(result)) console.log(line);
}
