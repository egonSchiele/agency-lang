import picomatch from "picomatch";
import { z } from "zod";
import { bashGlobMayName } from "./bashGlob.js";
import { scratchId } from "./scratchDir.js";

/** The longest pattern picomatch accepts. It throws on a longer one, and a
 *  rule that throws would break every interrupt that reaches it. */
export const MAX_PATTERN_LENGTH = 65536;

/** As the last item of a list pattern, "any items after this, or none". */
export const REST_OF_LIST = "**";

/** A glob for one value, or a list of globs matched against a list by
 *  position. See "Rule matching" in docs/dev/agents/approval-policies.md. */
export type MatchPattern = string | string[];

const PatternSchema = z
  .string()
  .max(MAX_PATTERN_LENGTH, `a pattern must be at most ${MAX_PATTERN_LENGTH} characters`);

export const PolicyRuleSchema = z
  .object({
    match: z.record(z.string(), z.union([PatternSchema, z.array(PatternSchema)])).optional(),
    action: z.enum(["approve", "reject", "propagate"]),
    /** Message the rejection carries back to whoever raised the interrupt —
     *  for a rejected tool call, what the model reads (e.g. "Use safeBash
     *  instead of bash"). Only valid on a reject rule. */
    rejectMessage: z.string().min(1, "rejectMessage must not be empty").optional(),
    /** Let this rule's globs match path segments that start with a period,
     *  so `/x/**` reaches `/x/.cache/y`. Off by default. */
    matchDotFolders: z.boolean().optional(),
  })
  .refine((rule) => rule.rejectMessage === undefined || rule.action === "reject", {
    message: 'rejectMessage is only valid on a rule whose action is "reject"',
  });

export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z.record(z.string(), z.array(PolicyRuleSchema));

export type Policy = z.infer<typeof PolicySchema>;

type PolicyResult =
  | { type: "approve" }
  | { type: "reject"; message?: string; value?: string }
  | { type: "propagate" };

/** The result for one matched rule. A reject rule's `rejectMessage` rides
 *  along as `message` — the documented field — and again as `value`,
 *  because a handler may return this result directly as its response
 *  (`return checkPolicy(policy, intr)` is a supported idiom) and the
 *  handler chain reads a rejection's reason from `value`. */
function ruleResult(rule: PolicyRule, dirs: PolicyDirs): PolicyResult {
  if (rule.action === "reject" && rule.rejectMessage !== undefined) {
    const message = fillPlaceholders(rule.rejectMessage, dirs);
    return { type: "reject", message, value: message };
  }
  return { type: rule.action };
}

/** A reject message with each named placeholder replaced by its plain
 *  path, so the model reads a real folder. A placeholder with no folder
 *  stays as written. */
function fillPlaceholders(text: string, dirs: PolicyDirs): string {
  return namedFolders(dirs).reduce(
    (filled, [placeholder, folder]) =>
      folder === null || folder === undefined ? filled : filled.split(placeholder).join(folder),
    text,
  );
}

/** Each named placeholder with the folder it stands for in this check. */
function namedFolders(dirs: PolicyDirs): [string, string | null | undefined][] {
  return [
    [AGENCY_INSTALL_DIR_PLACEHOLDER, dirs.agencyInstallDir],
    [AGENT_HOME_PLACEHOLDER, dirs.agentHome],
    [HOME_PLACEHOLDER, dirs.home],
    [SCRATCH_PLACEHOLDER, dirs.scratch],
  ];
}

/** Whether a reject message sends the model to a scratch folder this run
 *  does not have. Such a rule does not match: its message would tell the
 *  model to write under `<scratch>`, which is no path. Only `<scratch>` is
 *  checked, because it is the one placeholder a run is meant to be able to
 *  lack. The wording of any other message never decides whether its rule
 *  fires. */
function messageNamesNoFolder(rule: PolicyRule, dirs: PolicyDirs): boolean {
  const message = rule.rejectMessage;
  const missing = dirs.scratch === null || dirs.scratch === undefined;
  return message !== undefined && missing && message.includes(SCRATCH_PLACEHOLDER);
}

/** Escape picomatch metacharacters so a literal value matches only itself
 *  inside a pattern. Used for every value a generated rule pins, and for
 *  the base directory of the built-in scoped policies. */
export function escapeGlob(s: string): string {
  return s.replace(/[\\*?{}()[\]!@+|,^$"]/g, "\\$&");
}

export function checkPolicy(
  policy: Policy,
  interrupt: PolicyInterrupt,
  dirs: PolicyDirs,
): PolicyResult {
  return checkPolicyExplicit(policy, interrupt, dirs) ?? { type: "propagate" };
}

/** Like `checkPolicy`, but returns null when NO rule matched — callers that
 * need to distinguish an explicit `propagate` rule from plain fall-through
 * (e.g. the run-policy chain handler, which must stay silent on effects the
 * policy never mentions) use this; everyone else keeps `checkPolicy`'s
 * fall-through-is-propagate contract. */
export function checkPolicyExplicit(
  policy: Policy,
  interrupt: PolicyInterrupt,
  given: PolicyDirs,
): PolicyResult | null {
  const dirs = withRunScratch(given, interrupt.runId);
  // Effect-specific rules take precedence over the wildcard.
  const rules = policy[interrupt.effect];
  if (rules) {
    for (const rule of rules) {
      if (matchesRule(rule, interrupt, dirs)) {
        return ruleResult(rule, dirs);
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
      if (matchesRule(rule, interrupt, dirs)) {
        return ruleResult(rule, dirs);
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
/** The directories a `dir` pattern can stand for, resolved once when the
 *  run's context is built (lib/runtime/policyDirs.ts). The matcher takes
 *  them as plain strings and touches no file: it runs while an interrupt is
 *  being answered, and a disk read does not belong on that path. */
export type PolicyDirs = {
  /** Where the agent was launched; what `.` means in a `dir` pattern. */
  cwd: string;
  /** What `<agent-home>` means. */
  agentHome: string;
  /** What `<home>` means: the user's home directory. */
  home: string;
  /** What `<agency>` means, or null when the install root cannot be found
   *  (a bundled build with no package.json above it). The placeholder then
   *  stays as written, so the rule never matches; nothing throws. */
  agencyInstallDir: string | null;
  /** The real path of the folder every run's scratch folder is in, or
   *  absent when the host could not say. Resolved once from the host. */
  scratchParent?: string | null;
  /** What `<scratch>` means: one run's scratch folder. An execution
   *  context sets it for its own run. Outside a run it is absent, and the
   *  matcher works it out from `scratchParent` and the interrupt's run id.
   *  With neither, the placeholder stays as written and the rule never
   *  matches. */
  scratch?: string | null;
};

/** `dirs` with `scratch` set for the run `runId`, unless it is set already
 *  or there is no parent folder or run id to build it from. Reads no file. */
export function withRunScratch(dirs: PolicyDirs, runId: string | undefined): PolicyDirs {
  if (typeof dirs.scratch === "string" || !dirs.scratchParent || !runId) {
    return dirs;
  }
  return { ...dirs, scratch: `${dirs.scratchParent}/${scratchId(runId)}` };
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
// The launch path is data, not pattern: without escaping, a directory
// whose name contains glob characters (say `v*1`) would widen the rule to
// its siblings — a safety boundary, so the substituted prefix must match
// itself only. Glob syntax stays live only in the user-written suffix.
// `resolvedCwd` is the real path of the launch directory, so a symlinked one
// (a linked checkout, macOS /tmp) shares one path identity with interrupt
// payloads, which the contained-filename wrappers canonicalize the same way.
export function substituteDot(pattern: string, resolvedCwd: string): string {
  // Callback, not a replacement string: a legal cwd containing `$&`/`$'`
  // would otherwise be interpreted as replacement-string syntax.
  return pattern.replace(
    /(^|\{|,)\.(?=$|\/|,|\})/g,
    (_match, prefix) => prefix + escapeGlob(resolvedCwd),
  );
}

/** In a `dir` pattern, `<agency>` stands for the directory the agency
 *  package is installed in. A rule approving reads of the shipped docs and
 *  skills can then be saved to a policy file without pinning the install
 *  path of one machine or one version. */
export const AGENCY_INSTALL_DIR_PLACEHOLDER = "<agency>";

/** Replace `<agency>` with the resolved install directory, escaped so a
 *  path containing glob or brace characters stays literal. */
export function substituteInstallDir(pattern: string, installDir: string | null): string {
  if (installDir === null || !pattern.includes(AGENCY_INSTALL_DIR_PLACEHOLDER)) {
    return pattern;
  }
  return pattern.split(AGENCY_INSTALL_DIR_PLACEHOLDER).join(escapeGlob(installDir));
}

/** In a `dir` pattern, `<agent-home>` stands for the agent home directory
 *  (`AGENCY_AGENT_HOME`, or `~/.agency-agent`). The built-in read scope
 *  uses it for the home and everything under it, and the write scope for
 *  the agent's own settings file, so a saved policy keeps meaning
 *  "wherever the agent home is now". */
export const AGENT_HOME_PLACEHOLDER = "<agent-home>";

/** Replace `<agent-home>` with the resolved home, escaped the same way. */
export function substituteAgentHome(pattern: string, agentHome: string): string {
  if (!pattern.includes(AGENT_HOME_PLACEHOLDER)) {
    return pattern;
  }
  return pattern.split(AGENT_HOME_PLACEHOLDER).join(escapeGlob(agentHome));
}

/** In a `dir` pattern, `<home>` stands for the user's home directory. The
 *  built-in read scope uses it for `~/.claude/skills` only. */
export const HOME_PLACEHOLDER = "<home>";

/** Replace `<home>` with the resolved home, escaped the same way. */
export function substituteHome(pattern: string, home: string): string {
  if (!pattern.includes(HOME_PLACEHOLDER)) {
    return pattern;
  }
  return pattern.split(HOME_PLACEHOLDER).join(escapeGlob(home));
}

/** In a path pattern, `<scratch>` stands for the scratch folder of the run
 *  that raised the interrupt (lib/runtime/scratchDir.ts). The built-in
 *  policies approve file work there, so a saved policy names no run. */
export const SCRATCH_PLACEHOLDER = "<scratch>";

/** Replace `<scratch>` with the run's scratch folder, escaped the same
 *  way. With no folder, the pattern stays as written and never matches. */
export function substituteScratch(pattern: string, scratch: string | null | undefined): string {
  if (scratch === null || scratch === undefined || !pattern.includes(SCRATCH_PLACEHOLDER)) {
    return pattern;
  }
  return pattern.split(SCRATCH_PLACEHOLDER).join(escapeGlob(scratch));
}

/** Every directory placeholder in `pattern` replaced by what it means for
 *  this run. `.` is handled apart, by `substituteDot`. */
export function substitutePlaceholders(pattern: string, dirs: PolicyDirs): string {
  const withInstall = substituteInstallDir(pattern, dirs.agencyInstallDir);
  const withAgentHome = substituteAgentHome(withInstall, dirs.agentHome);
  const withHome = substituteHome(withAgentHome, dirs.home);
  return substituteScratch(withHome, dirs.scratch);
}

/** The data fields that hold a path, where the named placeholders
 *  (`<agent-home>`, `<home>`, `<agency>`) are resolved: `dir` for the
 *  single-file effects, `target` for a remove, `src` and `dest` for a copy
 *  or a move. `.` is resolved in `dir` alone. */
const PLACEHOLDER_FIELDS = ["dir", "target", "src", "dest"];

function matchesGlob(value: string, pattern: string, dot: boolean): boolean {
  return pattern === "" ? value === "" : picomatch.isMatch(value, pattern, { dot });
}

/** What the matcher reads of an interrupt. `runId` says which run raised
 *  it, which is what `<scratch>` stands for when the dirs do not say. */
export type PolicyInterrupt = {
  effect: string;
  message: string;
  data: any;
  origin: string;
  runId?: string;
};

function matchesRule(rule: PolicyRule, interrupt: PolicyInterrupt, dirs: PolicyDirs): boolean {
  if (messageNamesNoFolder(rule, dirs)) return false;
  if (!rule.match) return true; // catch-all
  const dot = rule.matchDotFolders === true;
  const seesGlobs = rule.action !== "approve";
  return Object.entries(rule.match).every(([key, pattern]) =>
    matchesField(key, pattern, fieldValue(key, interrupt), dot, seesGlobs, dirs),
  );
}

function fieldValue(key: string, interrupt: PolicyInterrupt): unknown {
  if (key === "origin") return interrupt.origin;
  if (key === "message") return interrupt.message;
  return interrupt.data?.[key];
}

/** Whether one field of an interrupt matches one pattern of a rule. Which
 *  comparison applies depends on the shapes of the two, and for a scalar
 *  value on whether the rule approves: the table is in "Rule matching" in
 *  docs/dev/agents/approval-policies.md. */
function matchesField(
  key: string,
  pattern: MatchPattern,
  value: unknown,
  dot: boolean,
  seesGlobs: boolean,
  dirs: PolicyDirs,
): boolean {
  // A null field is one the call did not fill in, such as `file` on a
  // directory search, so a rule that names it does not match.
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return matchesList(pattern, value, dot);
  if (typeof pattern !== "string" || !isScalar(value)) return false;
  const text = String(value);
  if (matchesScalar(key, pattern, text, dot, dirs)) {
    return true;
  }
  // A reject or propagate rule also matches a value that can name the
  // rule's file: `cat config/*.json` asks with the filename `*.json`, and
  // a reject rule for `secrets.json` must see it.
  return seesGlobs && bashGlobMayName(stripDotSlash(text), stripDotSlash(pattern));
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function matchesScalar(
  key: string,
  pattern: string,
  value: string,
  dot: boolean,
  dirs: PolicyDirs,
): boolean {
  // The raw pattern first (relative values match relative patterns as
  // before), then the cwd-resolved form for dir patterns, so `.` gains its
  // meaning without taking any match away.
  const raw = matchesGlob(stripDotSlash(value), stripDotSlash(pattern), dot);
  const viaDot =
    !raw &&
    key === "dir" &&
    matchesGlob(stripDotSlash(value), stripDotSlash(substituteDot(pattern, dirs.cwd)), dot);
  const viaPlaceholders =
    !raw &&
    !viaDot &&
    PLACEHOLDER_FIELDS.includes(key) &&
    matchesGlob(stripDotSlash(value), substitutePlaceholders(pattern, dirs), dot);
  return raw || viaDot || viaPlaceholders;
}

/** A string pattern matches a list when the list is not empty and every
 *  item matches. An empty list must not pass: `git add --all` raises with
 *  no paths, and a rule for `src/**` must not approve it. A list pattern
 *  matches item by item, and a last `**` stands for any items after it. */
function matchesList(pattern: MatchPattern, items: unknown[], dot: boolean): boolean {
  if (!items.every(isScalar)) return false;
  const texts = items.map(String);
  if (typeof pattern === "string") {
    return texts.length > 0 && texts.every((item) => matchesItem(item, pattern, dot));
  }
  const hasRest = pattern[pattern.length - 1] === REST_OF_LIST;
  const fixed = hasRest ? pattern.slice(0, -1) : pattern;
  const fits = hasRest ? texts.length >= fixed.length : texts.length === fixed.length;
  return fits && fixed.every((one, index) => matchesItem(texts[index], one, dot));
}

/** One list item against one glob, compared as written. picomatch drops a
 *  leading `./` from a pattern, which would make the argument `x` match a
 *  rule saved for `./x`, so the prefix is compared here, before the glob. */
function matchesItem(item: string, pattern: string, dot: boolean): boolean {
  const patternHasPrefix = pattern.startsWith("./");
  if (patternHasPrefix !== item.startsWith("./")) return false;
  return patternHasPrefix
    ? matchesGlob(item.slice(2), pattern.slice(2), dot)
    : matchesGlob(item, pattern, dot);
}

export function validatePolicy(policy: any): { success: boolean; error?: string } {
  const result = PolicySchema.safeParse(policy);
  if (!result.success) {
    return { success: false, error: result.error.message };
  }
  return { success: true };
}
