// Suite identity: the short name a run's test set groups under, derived
// from the harness `run` row's `suite.source`. The name itself comes from
// `benchmarkFromSuite`, the one suite-name parser; this file adds the
// explorer's display: a dash for unknown, `inline:…` and "optimize" shown
// as they are, a shortened `@<ref>` suffix for git sources, and clipping.
// Pure.
import { benchmarkFromSuite, gitRefOf, looksLikeGitUrl } from "@/runDirectory/benchmark.js";
import { MAX_IDENTITY_LABEL_CHARS } from "./identity.js";

export const UNKNOWN_SUITE = "—";
const GIT_REF_CHARS = 8;

/** The short suite name for a `run` row's suite identity; `null` (an
 *  ad-hoc directory, or a run with no suite on record) is unknown. */
export function suiteFromSource(source: string | null | undefined): string {
  if (source === null || source === undefined) {
    return UNKNOWN_SUITE;
  }
  if (source === "optimize") {
    return source;
  }
  if (source.startsWith("inline:")) {
    return clip(source.replace(/\s+/g, " "));
  }
  const name = benchmarkFromSuite(source);
  if (name === null) {
    return UNKNOWN_SUITE;
  }
  const ref = looksLikeGitUrl(source) ? gitRefOf(source) : undefined;
  if (ref === undefined) {
    return clip(name);
  }
  return clip(`${name}@${ref.slice(0, GIT_REF_CHARS)}`);
}

function clip(value: string): string {
  if (value.length <= MAX_IDENTITY_LABEL_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_IDENTITY_LABEL_CHARS - 1)}…`;
}
