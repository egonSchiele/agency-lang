// Suite identity: the short name a run's test set groups under, derived
// from config.json's provenance.inputsSource.source. The source string
// formats are the ones lib/cli/eval/run.ts and lib/optimize actually
// write: a local path, a git URL (optionally ?ref=), "inline:--goal",
// "optimize", or "unspecified". Pure — malformed provenance comes back
// as a warning, never a log line.
import { MAX_IDENTITY_LABEL_CHARS } from "./identity.js";
import type { EvalRunConfig } from "./readRunSummary.js";

export const UNKNOWN_SUITE = "—";
const GIT_REF_CHARS = 8;

export type SuiteResolution = { suite: string; warning?: string };

export function suiteFromConfig(config: EvalRunConfig | null): SuiteResolution {
  if (config === null) {
    return { suite: UNKNOWN_SUITE };
  }
  const source = config.provenance?.inputsSource?.source;
  if (typeof source === "string") {
    return { suite: suiteFromSource(source) };
  }
  const legacySource = (config as Record<string, unknown>).inputsSource;
  if (typeof legacySource === "string") {
    return { suite: suiteFromSource(legacySource) };
  }
  if (config.provenance === undefined) {
    return { suite: UNKNOWN_SUITE };
  }
  return {
    suite: UNKNOWN_SUITE,
    warning: `config.json provenance.inputsSource.source is not a string`,
  };
}

function suiteFromSource(source: string): string {
  if (source === "" || source === "unspecified") {
    return UNKNOWN_SUITE;
  }
  if (source.startsWith("inline:")) {
    return clip(source.replace(/\s+/g, " "));
  }
  if (looksLikeGitUrl(source)) {
    return gitSuite(source);
  }
  return clip(dataBasename(source));
}

/** Mirrors lib/eval/sources.ts looksLikeGitUrl — a copy small enough
 *  that importing eval internals here is not worth the coupling. */
function looksLikeGitUrl(candidate: string): boolean {
  return candidate.startsWith("git@") || candidate.includes("://")
    || /^github\.com\//.test(candidate) || candidate.endsWith(".git")
    || candidate.includes(".git?ref=");
}

function gitSuite(source: string): string {
  const refAt = source.indexOf("?ref=");
  const ref = refAt === -1 ? undefined : source.slice(refAt + "?ref=".length);
  const base = refAt === -1 ? source : source.slice(0, refAt);
  const repo = dataBasename(base.replace(/\.git$/, "").replace(/\/+$/, ""));
  if (ref === undefined || ref === "") {
    return clip(repo);
  }
  return clip(`${repo}@${ref.slice(0, GIT_REF_CHARS)}`);
}

/** Basename with data-file extensions stripped: terminal-bench.json →
 *  terminal-bench. Also strips git@host: prefixes. */
function dataBasename(source: string): string {
  const lastSegment = source.split(/[/:]/).filter((part) => part !== "").pop() ?? source;
  return lastSegment.replace(/\.(json|jsonl|agency)$/, "");
}

function clip(value: string): string {
  if (value.length <= MAX_IDENTITY_LABEL_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_IDENTITY_LABEL_CHARS - 1)}…`;
}
