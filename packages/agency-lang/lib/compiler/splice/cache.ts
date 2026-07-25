import fs from "node:fs";
import { createHash } from "node:crypto";
import { closureFiles } from "./eligibility.js";
import type { AgencyConfig } from "../../config.js";
import type { Code } from "../../runtime/template/code.js";
import type { SpliceDiagnostic, SpliceResult } from "./types.js";

/**
 * Memoized generator results and eligibility verdicts.
 *
 * Not an optimization. `SymbolTable.build` has twelve non-test callers,
 * and the LSP server calls it on every keystroke. Without a cache, each
 * splice in an open file would fork a child process per character typed.
 *
 * Module-level, like the parse cache. Compiler-side memoization is not the
 * per-run program state that belongs in the GlobalStore.
 */

/**
 * One remembered answer.
 *
 * The slot and the fingerprint do different jobs. The slot identifies the
 * call, so a newer answer for the same call replaces the older one and a
 * long editing session cannot accumulate entries. The fingerprint says
 * whether the answer is still good.
 *
 * Both stores use this shape so neither needs a composite key or a prune
 * pass over the whole store.
 */
type Entry<T> = { fingerprint: string; value: T };

const results: Record<string, Entry<SpliceResult<Code>>> = Object.create(null);
const verdicts: Record<string, Entry<SpliceDiagnostic | null>> = Object.create(null);

/** Which call this is: the generator being called, and how. Stable across
 *  edits to any of the files involved, which is what makes an entry
 *  replaceable rather than additive. */
export function spliceCacheSlot(expression: string, generatorPath: string): string {
  return `${generatorPath}\0${expression}`;
}

/**
 * Whether a remembered answer is still good: a hash over every file that
 * can change what the generator returns.
 *
 * `roots` is every module the runner will import, not just the generator.
 * A splice may pass an imported value as an argument, and the module
 * supplying it is imported by the HOST, so it need not appear anywhere in
 * the generator's own closure:
 *
 *     import { makeFieldGetters } from "./gen.agency"    // imports only std::
 *     import { FIELDS } from "./fields.agency"           // not in gen's closure
 *
 *     $( makeFieldGetters(FIELDS) )
 *
 * Adding a field to `fields.agency` changes what the generator returns
 * while leaving the expression text and the generator's closure untouched.
 * Hashing only the generator meant the memo served the old expansion, and
 * a fresh `agency compile` hid it because that process starts empty. The
 * editor, `agency serve`, and watch mode do not.
 */
export function spliceCacheKey(
  expression: string,
  roots: readonly string[],
  config: AgencyConfig = {},
): string {
  const hash = createHash("sha256");
  feed(hash, expression);
  const files = roots
    .flatMap((root) => closureFiles(root, config))
    .filter((file, index, all) => all.indexOf(file) === index)
    .sort();
  for (const file of files) {
    feed(hash, file);
    feed(hash, readOrEmpty(file));
  }
  return hash.digest("hex");
}

/**
 * Add one piece to the hash, length first.
 *
 * Without the length, concatenation is ambiguous: a file named `a` holding
 * `b c` hashes the same as a file named `a b` holding `c`. It takes a
 * crafted path to reach, but this hash decides whether to re-run generated
 * code, so it should not be ambiguous at all.
 */
function feed(hash: ReturnType<typeof createHash>, chunk: string): void {
  hash.update(String(Buffer.byteLength(chunk)));
  hash.update(":");
  hash.update(chunk);
}

function readOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    // A file that cannot be read contributes nothing, and no check refuses
    // the generator over it. That is deliberate rather than an oversight:
    // a closure file that is missing or unparseable also fails to compile,
    // so the generator cannot run successfully either way.
    return "";
  }
}

/**
 * Run `produce` unless this call has already been answered for exactly
 * this content.
 *
 * Failures are cached too. A broken generator is the case the editor hits
 * hardest, because the user is reading the error while still typing. The
 * caller re-anchors the diagnostic, since a cached failure carries the
 * position of whichever splice ran first.
 */
export function cachedGeneratorRun(
  slot: string,
  fingerprint: string,
  produce: () => SpliceResult<Code>,
): SpliceResult<Code> {
  const found = results[slot];
  if (found !== undefined && found.fingerprint === fingerprint) {
    return found.value;
  }
  const value = produce();
  results[slot] = { fingerprint, value };
  return value;
}

/**
 * Remember whether a generator may run, against the same fingerprint the
 * result uses.
 *
 * Eligibility is decided before the generator runs, so it sits outside
 * `cachedGeneratorRun` and used to re-run on every call. That is a closure
 * walk per check, per splice, per keystroke once the editor is involved.
 *
 * Sound on the same fingerprint because that fingerprint now covers every
 * file the checks read: the generator's closure and every argument
 * module's closure.
 *
 * Note `null` is a real verdict here, meaning eligible. Wrapping it in an
 * `Entry` is what lets an ordinary `undefined` check distinguish "not
 * cached" from "cached as fine".
 */
export function cachedEligibility(
  slot: string,
  fingerprint: string,
  judge: () => SpliceDiagnostic | null,
): SpliceDiagnostic | null {
  const found = verdicts[slot];
  if (found !== undefined && found.fingerprint === fingerprint) {
    return found.value;
  }
  const value = judge();
  verdicts[slot] = { fingerprint, value };
  return value;
}

/** Tests only: the cache outlives a single compile by design. */
export function clearSpliceCache(): void {
  for (const key of Object.keys(results)) {
    delete results[key];
  }
  for (const key of Object.keys(verdicts)) {
    delete verdicts[key];
  }
}

/** Tests only: total remembered entries across both stores, so a test
 *  asserting the cache does not grow can see either one leaking. */
export function spliceCacheSize(): number {
  return Object.keys(results).length + Object.keys(verdicts).length;
}
