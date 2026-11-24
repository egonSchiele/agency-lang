// The benchmark a run belongs to, derived from its harness `run` row's
// `suite.source`. The source formats are the ones lib/cli/eval/run.ts and
// lib/optimize write: a local path, a git URL (optionally `//subdir` and
// `?ref=`), "inline:--input", "optimize", or "unspecified". The runs
// explorer's suite column builds on the same parser, so the explorer and
// statelog always agree on a run's name. Pure, and never throws.

const REF_SEPARATOR = "?ref=";

/** The suite's folder or file name without its data extension, or the
 *  repository's (or its subfolder's) name for a git source. Null for a
 *  run with no suite on record, an `--input` run, and an optimize run. */
export function benchmarkFromSuite(source: string | null | undefined): string | null {
  if (source === null || source === undefined) {
    return null;
  }
  if (source === "" || source === "unspecified" || source === "optimize") {
    return null;
  }
  if (source.startsWith("inline:")) {
    return null;
  }
  const name = looksLikeGitUrl(source) ? gitName(source) : dataBasename(source);
  return name === "" ? null : name;
}

/** Mirrors lib/eval/sources.ts looksLikeGitUrl: a copy small enough that
 *  importing eval internals here is not worth the coupling. */
export function looksLikeGitUrl(candidate: string): boolean {
  return (
    candidate.startsWith("git@") ||
    candidate.includes("://") ||
    /^github\.com\//.test(candidate) ||
    candidate.endsWith(".git") ||
    candidate.includes(".git?ref=")
  );
}

/** The `?ref=` part of a git source, or undefined when it has none. */
export function gitRefOf(source: string): string | undefined {
  const refAt = source.indexOf(REF_SEPARATOR);
  if (refAt === -1) {
    return undefined;
  }
  const ref = source.slice(refAt + REF_SEPARATOR.length);
  return ref === "" ? undefined : ref;
}

function gitName(source: string): string {
  const refAt = source.indexOf(REF_SEPARATOR);
  const base = refAt === -1 ? source : source.slice(0, refAt);
  return dataBasename(base.replace(/\/+$/, "").replace(/\.git$/, ""));
}

/** Basename with data-file extensions stripped: terminal-bench.json →
 *  terminal-bench. Also strips git@host: prefixes. */
function dataBasename(source: string): string {
  const lastSegment =
    source
      .split(/[/:]/)
      .filter((part) => part !== "")
      .pop() ?? source;
  return lastSegment.replace(/\.(json|jsonl|agency)$/, "");
}
