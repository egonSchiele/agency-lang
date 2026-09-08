import prompts from "prompts";
import * as path from "node:path";
import {
  CURATED_LOCAL_MODELS,
  _resolveModel,
  _resolveModelName,
  _removeMlxModel,
  _modelFilesOnDisk,
  readModelAliases,
  type ResolvedModel,
  isMlxUri,
  parseMlxUri,
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
import type { DownloadEvent } from "../stdlib/hubDownload.js";
import { ttyColor } from "../utils/termcolors.js";
import { terminalSafe } from "./remote/secretsInput.js";

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
export function downloadChoices(entries: ModelNameEntry[]): { title: string; value: string }[] {
  const rows = entries.map((e) => ({
    title:
      e.params !== undefined && e.sizeBytes !== undefined
        ? `${e.name}  (${e.params}, ${formatGB(e.sizeBytes)})`
        : e.name,
    value: e.name,
  }));
  return [
    ...rows,
    { title: "custom (hf: URI, .gguf path, mlx: URI, or model directory)…", value: CUSTOM_CHOICE },
  ];
}

export async function runDownload(value?: string): Promise<void> {
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
        message: "hf: URI, .gguf path, mlx: URI, or model directory:",
      });
      if (custom.value == null || custom.value === "") return;
      picked = custom.value as string;
    }
  }
  // Show the source it resolved to (the hf: URI for a name/alias) and the
  // local path it landed at. For a .gguf-path input the two are the same, so
  // the source line is skipped.
  const resolved = _resolveModel(picked);
  if (resolved.backend === "llama-cpp") {
    gate();
  }
  const source = resolved.target;
  const modelPath = await _downloadModel(picked, "", {
    onEvent: printDownloadEvent(process.stdout.isTTY === true),
  });
  if (source !== modelPath) {
    console.log(`source: ${source}`);
  }
  console.log(`model:  ${modelPath}`);
}

/** One line per event. The byte counter rewrites one terminal line with
 *  the percent, the rate, and the time left, and off a terminal prints a
 *  line at every tenth percent instead, so a log of a long download still
 *  shows how far it got. */
export function printDownloadEvent(
  tty: boolean,
  write: (s: string) => void = (s) => process.stdout.write(s),
  now: () => number = Date.now,
): (e: DownloadEvent) => void {
  const rate = new RateMeter(now);
  let counterShown = false;
  let lastTenth = -1;
  const endCounter = () => {
    if (counterShown) {
      write("\n");
      counterShown = false;
    }
  };
  return (e) => {
    if (e.kind === "bytes") {
      const percent = e.total === 0 ? 100 : Math.floor((100 * e.done) / e.total);
      const line = `  ${formatGB(e.done)} / ${formatGB(e.total)}  ${percent}%`;
      if (tty) {
        write(`\r\x1b[2K${line}${rate.describe(e.done, e.total)}`);
        counterShown = true;
        if (e.done >= e.total) {
          endCounter();
        }
      } else if (Math.floor(percent / 10) > lastTenth) {
        lastTenth = Math.floor(percent / 10);
        write(`${line}\n`);
      }
      return;
    }
    endCounter();
    // The path comes from the repo's tree, so it is quoted if it could
    // move the cursor or forge a line.
    const name = terminalSafe(e.path);
    if (e.kind === "file-start") {
      const resumed = e.resumedBytes > 0 ? `  (resuming from ${formatGB(e.resumedBytes)})` : "";
      write(`${name}  ${formatGB(e.size)}${resumed}\n`);
    } else if (e.kind === "adopt") {
      write(`${name}  already on disk, verified\n`);
    } else if (e.kind === "verify") {
      write(e.ok ? `  verified ${name}\n` : `  ${name} failed verification\n`);
    }
  };
}

/** The download rate over the last few seconds and the time it implies
 *  for the rest, as `  45.2 MB/s  12m left`. Blank until there are two
 *  samples to compare. */
class RateMeter {
  private samples: { at: number; done: number }[] = [];

  constructor(private readonly now: () => number) {}

  describe(done: number, total: number): string {
    const at = this.now();
    this.samples.push({ at, done });
    this.samples = this.samples.filter((s) => at - s.at <= RATE_WINDOW_MS);
    const first = this.samples[0];
    if (at - first.at < 1000 || done <= first.done) {
      return "";
    }
    const bytesPerSecond = ((done - first.done) * 1000) / (at - first.at);
    const left = Math.round((total - done) / bytesPerSecond);
    return `  ${(bytesPerSecond / 1e6).toFixed(1)} MB/s  ${formatDuration(left)} left`;
  }
}

const RATE_WINDOW_MS = 10_000;

function formatDuration(seconds: number): string {
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  if (seconds >= 60) {
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

/** Without `-f`: drop the alias, keep the files, and say where they are.
 *  With `-f`: delete the files too. Models are large, so deleting is the
 *  step that needs the flag. */
export function runRemove(name: string, opts: { force: boolean }): void {
  const aliases = readModelAliases();
  const isAlias = Object.hasOwn(aliases, name);
  const isCurated = Object.hasOwn(CURATED_LOCAL_MODELS, name);

  // Resolve before touching the alias, but let a stale alias (its directory
  // moved or deleted) still be removed: the alias is the thing being removed,
  // and its target no longer matters.
  let resolved: ResolvedModel | null;
  try {
    resolved = _resolveModel(name);
  } catch (err) {
    if (!isAlias) {
      throw err;
    }
    resolved = null;
  }
  const files = resolved === null ? null : _modelFilesOnDisk(resolved);
  const where = files === null ? null : `${files.path} (${formatGB(files.sizeBytes)})`;

  if (isAlias) {
    const { file } = _unaliasModel(name);
    console.log(`Removed alias "${name}" from ${file}.`);
  } else if (isCurated && !opts.force) {
    console.log(`"${name}" is a built-in catalog entry, so there is no alias to remove.`);
  }

  if (!opts.force) {
    if (files !== null && !files.insideCache) {
      console.log(
        `The model files are still at ${where}. They are outside the models directory, so delete them yourself if you want them gone.`,
      );
    } else if (where !== null) {
      console.log(`The model files are still at ${where}.`);
      console.log("Run again with -f to delete them.");
    } else if (!isAlias && !isCurated) {
      console.log(`Nothing to remove for "${name}".`);
    }
    return;
  }

  if (files === null || resolved === null) {
    console.log(`Not found: ${name}`);
    return;
  }
  if (!files.insideCache) {
    console.error("That model is not in the models directory; remove it yourself.");
    process.exit(1);
  }
  if (resolved.backend === "mlx") {
    const repo = isMlxUri(resolved.target)
      ? parseMlxUri(resolved.target).repo
      : path.basename(files.path).replace("--", "/");
    const removed = _removeMlxModel(repo);
    console.log(removed ? `Deleted ${where}` : `Not found: ${name}`);
    return;
  }
  gate();
  const removed = _removeModel(path.basename(files.path));
  console.log(removed ? `Deleted ${where}` : `Not found: ${name}`);
}

export function runResolve(value: string): void {
  const { backend, target } = _resolveModel(value);
  console.log(`${backend}  ${target}`);
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
    lines.push(
      `Skipped ${ttyColor.yellow(`"${s.name}"`)}: kept your alias (${ttyColor.dim(s.keptUri)});`,
    );
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
