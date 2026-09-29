import type { ConfigTarget } from "../config/target.js";
import { ttyColor } from "../utils/termcolors.js";
import { isServedUri, parseServedUri } from "./modelBackend.js";
import { MODEL_KINDS, type ModelKind } from "./modelKind.js";
import {
  _listModelNames,
  defaultAliasTarget,
  formatGB,
  formatCtx,
  type DownloadedModel,
  type ModelNameEntry,
} from "./localModels.js";

/** The text `agency local list` and the catalog printers produce. Rendering
 *  only: what a model is, where it is, and whether it is downloaded come
 *  from `localModels.ts`. */

/** Width of a column: the longer of its header and its widest value. */
function colWidth(header: string, values: string[]): number {
  return Math.max(header.length, ...values.map((v) => v.length));
}

/** The `agency local list` view: every usable model (curated + aliases) with
 *  a downloaded marker, then cache-dir files no catalog entry claims. A row
 *  is "downloaded" when the manifest maps its target URI to a file that still
 *  exists in the cache dir; its SIZE column then shows the on-disk size
 *  rather than the catalog estimate. Compact and operational by default;
 *  `long` (the `-l` flag) adds each model's description on its own dimmed
 *  line, with a blank line between models so the descriptions stay readable.
 *  Returns the block with no trailing newline (the caller's `console.log`
 *  adds exactly one). */
export function formatLocalList(args: {
  dir: string;
  entries: ModelNameEntry[];
  manifest: Record<string, string>;
  files: DownloadedModel[];
  long?: boolean;
  /** Show only models of this kind. */
  kind?: ModelKind;
}): string {
  const byName = Object.fromEntries(args.files.map((f) => [f.name, f]));
  const byPath = Object.fromEntries(args.files.map((f) => [f.path, f]));
  // A catalog row's kind is its entry's; a file's is what its record or
  // its contents say. Rows come out in kind order, chat first, so the
  // models that answer one question sit together.
  const kindOfEntry = (e: ModelNameEntry): ModelKind | undefined => e.kind;
  const kindOrder = (kind: ModelKind | undefined): number =>
    kind === undefined ? MODEL_KINDS.length : MODEL_KINDS.indexOf(kind);
  // The file on disk that backs a catalog row, if any. A GGUF row goes
  // through the manifest. An MLX row matches by repo id, or by directory
  // for an alias that points straight at one.
  const fileFor = (e: ModelNameEntry): DownloadedModel | undefined => {
    if (e.backend === "llama-cpp") {
      const manifestFile = args.manifest[e.target];
      return manifestFile === undefined ? undefined : byName[manifestFile];
    }
    if (!isServedUri(e.target)) {
      const file = byPath[e.target];
      return file !== undefined && file.complete ? file : undefined;
    }
    // A pinned revision must match what was downloaded. The pin may be a
    // short prefix of the full commit hash. A repo can sit in more than one
    // layout, so every copy of it is a candidate, not just the last one.
    const { backend, repo, revision } = parseServedUri(e.target);
    const copies = args.files.filter((f) => f.backend === backend && f.name === repo && f.complete);
    if (revision === undefined) {
      return copies[0];
    }
    return copies.find((f) => (f.revision ?? "").startsWith(revision));
  };
  const wanted = args.entries.filter(
    (e) => args.kind === undefined || kindOfEntry(e) === args.kind,
  );
  const ordered = [...wanted].sort((a, b) => kindOrder(kindOfEntry(a)) - kindOrder(kindOfEntry(b)));
  const rows = ordered.map((e) => {
    const file = fileFor(e);
    return {
      mark: file !== undefined ? "✓" : "",
      name: e.name,
      kind: kindOfEntry(e) ?? "",
      backend: e.backend,
      params: e.params ?? "",
      size:
        file !== undefined
          ? formatGB(file.sizeBytes)
          : e.sizeBytes !== undefined
            ? formatGB(e.sizeBytes)
            : "",
      ctx: e.contextWindow !== undefined ? formatCtx(e.contextWindow) : "",
      license: e.license ?? "",
      tags: (e.tags ?? []).join(", "),
      description: e.description ?? "",
    };
  });
  // Only files claimed by a CATALOG row are excluded from OTHER FILES. The
  // manifest also records raw-URI downloads, which have no row here — their
  // files must stay visible.
  const claimedPaths: string[] = args.entries
    .map(fileFor)
    .filter((f): f is DownloadedModel => f !== undefined)
    .map((f) => f.path);
  const others = args.files.filter(
    (f) => !claimedPaths.includes(f.path) && (args.kind === undefined || f.kind === args.kind),
  );
  const headers = [
    "",
    "NAME",
    "KIND",
    "BACKEND",
    "PARAMS",
    "SIZE",
    "CONTEXT",
    "CATEGORY",
    "LICENSE",
  ];
  const cols = [
    colWidth(
      headers[0],
      rows.map((r) => r.mark),
    ),
    colWidth(
      headers[1],
      rows.map((r) => r.name),
    ),
    colWidth(
      headers[2],
      rows.map((r) => r.kind),
    ),
    colWidth(
      headers[3],
      rows.map((r) => r.backend),
    ),
    colWidth(
      headers[4],
      rows.map((r) => r.params),
    ),
    colWidth(
      headers[5],
      rows.map((r) => r.size),
    ),
    colWidth(
      headers[6],
      rows.map((r) => r.ctx),
    ),
    colWidth(
      headers[7],
      rows.map((r) => r.tags),
    ),
    colWidth(
      headers[8],
      rows.map((r) => r.license),
    ),
  ];
  const render = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(cols[i]))
      .join("  ")
      .trimEnd();
  // Indent descriptions two past where NAME starts (mark column + its
  // separator), so they read as nested under the model they describe.
  const descIndent = " ".repeat(cols[0] + 2 + 2);
  const lines = [`Models directory: ${args.dir}`, "", render(headers)];
  rows.forEach((r, i) => {
    // Blank line *between* models, not after the last one, so the sections
    // below (which push their own leading "") aren't double-spaced.
    if (args.long === true && i > 0) lines.push("");
    lines.push(
      render([r.mark, r.name, r.kind, r.backend, r.params, r.size, r.ctx, r.tags, r.license]),
    );
    if (args.long === true && r.description !== "") {
      lines.push(ttyColor.dim(`${descIndent}${r.description}`));
    }
  });
  if (others.length > 0) {
    lines.push("", "OTHER FILES");
    for (const f of others) {
      const facts = [
        ...(f.backend === "llama-cpp" ? [] : [f.backend]),
        ...(f.kind === undefined ? [] : [f.kind]),
        ...(f.complete ? [] : ["incomplete"]),
      ];
      const tag = facts.length === 0 ? "" : `  (${facts.join(", ")})`;
      lines.push(`  ${f.name}${tag}  ${formatGB(f.sizeBytes)}`);
    }
  }
  const total = args.files.reduce((sum, f) => sum + f.sizeBytes, 0);
  lines.push("", `Total downloaded: ${formatGB(total)}`);
  return lines.join("\n");
}

/** Render the usable-model list as an aligned table: a header row plus one
 *  fact row per curated model (params, tags, size, context window,
 *  license), the description on a dimmed line below, a blank line between
 *  models. User aliases (which carry no metadata) follow in an ALIASES
 *  section as `name → target`. Returns the block as a string with no trailing
 *  newline (the caller's `console.log` adds exactly one). */
export function formatModelCatalog(target: ConfigTarget = defaultAliasTarget()): string {
  const entries = _listModelNames(target);
  const hasMetadata = (m: ModelNameEntry): boolean =>
    m.params !== undefined ||
    m.sizeBytes !== undefined ||
    m.kind !== undefined ||
    m.contextWindow !== undefined ||
    m.license !== undefined ||
    m.description !== undefined;
  const curated = entries.filter(hasMetadata); // table rows: built-ins + rich aliases
  const aliases = entries.filter((m) => !hasMetadata(m)); // plain name→uri only
  const lines: string[] = [];

  if (curated.length > 0) {
    const rows = curated.map((m) => ({
      name: m.name,
      params: m.params ?? "",
      tags: (m.tags ?? []).join(", "),
      size: m.sizeBytes ? formatGB(m.sizeBytes) : "?",
      ctx: m.contextWindow ? formatCtx(m.contextWindow) : "",
      license: m.license ?? "",
      description: m.description ?? "",
    }));
    // Computed widths so columns fit the actual data (names range from ~10
    // to ~28 chars). SIZE and CTX are numeric, so they right-align.
    const w = {
      name: colWidth(
        "NAME",
        rows.map((r) => r.name),
      ),
      params: colWidth(
        "PARAMS",
        rows.map((r) => r.params),
      ),
      tags: colWidth(
        "TAGS",
        rows.map((r) => r.tags),
      ),
      size: colWidth(
        "SIZE",
        rows.map((r) => r.size),
      ),
      ctx: colWidth(
        "CTX",
        rows.map((r) => r.ctx),
      ),
    };
    const row = (
      name: string,
      params: string,
      tags: string,
      size: string,
      ctx: string,
      license: string,
    ): string =>
      `${name.padEnd(w.name)}  ${params.padEnd(w.params)}  ${tags.padEnd(
        w.tags,
      )}  ${size.padStart(w.size)}  ${ctx.padStart(w.ctx)}  ${license}`;

    // LICENSE is the last column, so it needs no trailing pad.
    lines.push(ttyColor.bold(row("NAME", "PARAMS", "TAGS", "SIZE", "CTX", "LICENSE")));
    rows.forEach((r, i) => {
      // Blank line *between* models, not after the last one, so the joined
      // string has no trailing newline (console.log adds exactly one).
      if (i > 0) lines.push("");
      lines.push(row(r.name, r.params, r.tags, r.size, r.ctx, r.license));
      if (r.description) lines.push(ttyColor.dim(`    ${r.description}`));
    });
  }

  if (aliases.length > 0) {
    if (lines.length > 0) lines.push(""); // separate the table from ALIASES
    lines.push(ttyColor.bold("ALIASES"));
    for (const a of aliases) {
      lines.push(`${a.name} → ${a.target}`);
    }
  }

  return lines.join("\n");
}

/** Print the model catalog to stdout. The agent's bare `--local-model`
 *  path calls this through `std::agency/local`. */
export function _printLocalCatalog(): void {
  console.log(formatModelCatalog());
}
