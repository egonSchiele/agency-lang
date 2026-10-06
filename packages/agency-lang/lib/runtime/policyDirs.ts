// The directories a policy's `dir` patterns stand for, resolved once when a
// run's context is built. The matcher in policy.ts takes these strings and
// touches no file, because it runs while an interrupt is being answered and
// an `await` or a disk read does not belong on that path.
//
// This file reads the disk, so it is Node-only for now. A later PR resolves
// the paths through the host's file part instead.

import { realpathSync } from "fs";
import { rootPath } from "../host/roots.js";
import { defaultHost } from "#default-host";
import { getPackageRoot } from "../importPaths.js";
import type { Host } from "../host/host.js";
import { root } from "../stdlib/contained.js";
import { agentHomeDir } from "./agentHome.js";
import { escapeGlob } from "./policy.js";

/** The resolved directories, each spelled the way file effects spell the
 *  paths in their payloads: the real path when the directory exists, its
 *  lexical spelling when it does not. */
export type PolicyDirs = {
  /** Where the agent was launched; what `.` means in a `dir` pattern. */
  cwd: string;
  /** What `<agent-home>` means. */
  agentHome: string;
  /** What `<agency>` means, or null when the install root cannot be found
   *  (a bundled build with no package.json above it). */
  agencyInstallDir: string | null;
};

/** Resolve the three directories through `host`. A directory that cannot
 *  be resolved keeps its lexical spelling, so matching stays as it was
 *  rather than failing every rule. */
export function resolvePolicyDirs(host: Host): PolicyDirs {
  const cwd = host.system.cwd();
  const home = agentHomeDir(host);
  return {
    cwd: realOrAsWritten(cwd),
    agentHome: realOrAsWritten(home),
    agencyInstallDir: installDirOrNull(),
  };
}

function realOrAsWritten(dir: string): string {
  try {
    return rootPath(root(dir));
  } catch {
    return dir;
  }
}

function installDirOrNull(): string | null {
  try {
    return getPackageRoot();
  } catch {
    return null;
  }
}

// In a `dir` pattern, `.` means "wherever the agent was launched". Tools
// absolutize the dir they put in interrupt data, so a literal `.` in a
// policy file could never match those; resolving it lets a static policy
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
// The cwd is realpathed so a symlinked launch directory (a linked
// checkout, macOS /tmp) shares one path identity with interrupt payloads,
// which the contained-filename wrappers canonicalize the same way.
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
  return substituteDot(pattern, realCwd);
}

/** Replace `.` in a `dir` pattern with the already-resolved launch
 *  directory. The matcher calls this with `PolicyDirs.cwd`. */
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
  return substituteInstallDir(pattern, resolved);
}

/** Replace `<agency>` with the already-resolved install directory. A null
 *  directory leaves the placeholder as written, so the rule never matches. */
export function substituteInstallDir(pattern: string, installDir: string | null): string {
  if (installDir === null || !pattern.includes(AGENCY_INSTALL_DIR_PLACEHOLDER)) return pattern;
  return pattern.split(AGENCY_INSTALL_DIR_PLACEHOLDER).join(escapeGlob(installDir));
}

/** In a `dir` pattern, `<agent-home>` stands for the agent home directory
 *  (`AGENCY_AGENT_HOME`, or `~/.agency-agent`). The built-in read scope
 *  uses it for the home and everything under it, and the write scope for
 *  the agent's own settings file, so a saved policy keeps meaning
 *  "wherever the agent home is now". */
export const AGENT_HOME_PLACEHOLDER = "<agent-home>";

/** Expand `<agent-home>` at match time, like `<agency>`. The home is
 *  escaped so a path containing glob or brace characters stays literal.
 *  Exported for tests, which inject the home. */
export function expandAgentHomeDir(
  pattern: string,
  home: () => string = canonicalAgentHomeFromProcess,
): string {
  if (!pattern.includes(AGENT_HOME_PLACEHOLDER)) return pattern;
  return substituteAgentHome(pattern, home());
}

/** Replace `<agent-home>` with the already-resolved home. */
export function substituteAgentHome(pattern: string, agentHome: string): string {
  if (!pattern.includes(AGENT_HOME_PLACEHOLDER)) return pattern;
  return pattern.split(AGENT_HOME_PLACEHOLDER).join(escapeGlob(agentHome));
}

/** The real spelling of the agent home, read through the platform's
 *  default host. A home that does not exist yet keeps a lexical tail. */
function canonicalAgentHomeFromProcess(): string {
  return realOrAsWritten(agentHomeDir(defaultHost()));
}
