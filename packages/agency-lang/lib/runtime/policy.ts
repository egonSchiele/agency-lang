import picomatch from "picomatch";
import { realpathSync } from "fs";
import { z } from "zod";
import { getPackageRoot } from "../importPaths.js";

export const PolicyRuleSchema = z.object({
  match: z.record(z.string(), z.string()).optional(),
  action: z.enum(["approve", "reject", "propagate"]),
});

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.record(z.string(), z.array(PolicyRuleSchema));

export type Policy = z.infer<typeof PolicySchema>;

type PolicyResult = { type: "approve" } | { type: "reject" } | { type: "propagate" };

/** Escape picomatch metacharacters so a literal value matches only itself
 *  inside a pattern. Used for every value a generated rule pins, and for
 *  the base directory of the built-in scoped policies. */
export function escapeGlob(s: string): string {
  return s.replace(/[\\*?{}()[\]!@+|,^$]/g, "\\$&");
}

export function checkPolicy(
  policy: Policy,
  interrupt: { effect: string; message: string; data: any; origin: string },
): PolicyResult {
  return checkPolicyExplicit(policy, interrupt) ?? { type: "propagate" };
}

/** Like `checkPolicy`, but returns null when NO rule matched — callers that
 * need to distinguish an explicit `propagate` rule from plain fall-through
 * (e.g. the run-policy chain handler, which must stay silent on effects the
 * policy never mentions) use this; everyone else keeps `checkPolicy`'s
 * fall-through-is-propagate contract. */
export function checkPolicyExplicit(
  policy: Policy,
  interrupt: { effect: string; message: string; data: any; origin: string },
): PolicyResult | null {
  // Effect-specific rules take precedence over the wildcard.
  const rules = policy[interrupt.effect];
  if (rules) {
    for (const rule of rules) {
      if (matchesRule(rule, interrupt)) {
        return { type: rule.action };
      }
    }
  }

  // Wildcard catch-all: the `"*"` effect key applies to any interrupt whose
  // own effect had no matching rule. This is how an "approve-all" policy
  // covers effects it doesn't enumerate (a plain per-effect map would
  // `propagate` — i.e. surface to the user — on anything unlisted).
  const wildcard = policy["*"];
  if (wildcard) {
    for (const rule of wildcard) {
      if (matchesRule(rule, interrupt)) {
        return { type: rule.action };
      }
    }
  }

  return null;
}

// picomatch fails to match patterns starting with `./` when combined
// with `**` or brace expansions (e.g. `./docs/guide{,/**}` vs
// `./docs/guide` returns false). Strip a leading `./` from both
// pattern and value so paths normalize before matching.
function stripDotSlash(s: string): string {
  return s.startsWith("./") ? s.slice(2) : s;
}

// The launch path is data, not pattern: without escaping, a directory
// whose name contains glob characters (say `v*1`) would widen the rule to
// its siblings — a safety boundary, so the substituted prefix must match
// itself only. Glob syntax stays live only in the user-written suffix.
function escapeForGlob(s: string): string {
  return s.replace(/[\\*?[\]{}()!+@|]/g, "\\$&");
}

// In a `dir` pattern, `.` also means "wherever the agent was launched".
// Tools absolutize the dir they put in interrupt data, so a literal `.` in
// a policy file could never match those; resolving it lets a static policy
// say "the current directory, whatever it is" instead of hard-coding an
// absolute path. The replacement covers `.` standing alone, at the start of
// a path (`./sub/**`), and as a brace alternative (`{.,./**}`). Note the
// same caveat as every dir glob: `**` does not descend into dot-led
// subdirectories (picomatch's dot rule), though a launch directory whose
// own path contains dot segments is fine — those sit in the literal prefix.
// The cwd is realpathed so a symlinked launch directory (a linked
// checkout, macOS /tmp) shares one path identity with interrupt payloads,
// which the contained-filename wrappers now canonicalize the same way.
// Exported for tests, which inject the cwd.
export function resolveDotDirPattern(pattern: string, cwd: string = process.cwd()): string {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    // A cwd that cannot be resolved keeps its lexical spelling: matching
    // stays exactly as before rather than failing every rule.
    realCwd = cwd;
  }
  // Callback, not a replacement string: a legal cwd containing `$&`/`$'`
  // would otherwise be interpreted as replacement-string syntax.
  return pattern.replace(
    /(^|\{|,)\.(?=$|\/|,|\})/g,
    (_match, prefix) => prefix + escapeForGlob(realCwd),
  );
}

/** In a `dir` pattern, `<agency>` stands for the directory the agency
 *  package is installed in. A rule approving reads of the shipped docs and
 *  skills can then be saved to a policy file without pinning the install
 *  path of one machine or one version. */
export const AGENCY_INSTALL_DIR_PLACEHOLDER = "<agency>";

// Expanded at match time, like `.`: a saved policy keeps saying "wherever
// agency is installed now". A root that cannot be found (a bundled build with
// no package.json above it) leaves the placeholder as written, so the rule
// simply never matches; nothing throws. Exported for tests, which inject the root.
export function expandAgencyInstallDir(
  pattern: string,
  root: () => string = getPackageRoot,
): string {
  if (!pattern.includes(AGENCY_INSTALL_DIR_PLACEHOLDER)) return pattern;
  let resolved: string;
  try {
    resolved = root();
  } catch {
    return pattern;
  }
  return pattern.split(AGENCY_INSTALL_DIR_PLACEHOLDER).join(escapeForGlob(resolved));
}

function matchesRule(
  rule: PolicyRule,
  interrupt: { effect: string; message: string; data: any; origin: string },
): boolean {
  if (!rule.match) return true; // catch-all

  for (const [key, pattern] of Object.entries(rule.match)) {
    let value: string | undefined;
    if (key === "origin") {
      value = interrupt.origin;
    } else if (key === "message") {
      value = interrupt.message;
    } else {
      value = interrupt.data?.[key];
    }

    if (value === undefined) return false;
    if (typeof value !== "string") value = String(value);

    // The raw pattern first (relative values match relative patterns as
    // before), then the cwd-resolved form for dir patterns, so `.` gains its
    // meaning without taking any match away.
    const raw = picomatch.isMatch(stripDotSlash(value), stripDotSlash(pattern));
    const viaDot =
      !raw &&
      key === "dir" &&
      picomatch.isMatch(stripDotSlash(value), stripDotSlash(resolveDotDirPattern(pattern)));
    const viaInstall =
      !raw &&
      !viaDot &&
      key === "dir" &&
      picomatch.isMatch(stripDotSlash(value), expandAgencyInstallDir(pattern));
    if (!raw && !viaDot && !viaInstall) {
      return false;
    }
  }

  return true;
}

export function validatePolicy(policy: any): { success: boolean; error?: string } {
  const result = PolicySchema.safeParse(policy);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true };
}
