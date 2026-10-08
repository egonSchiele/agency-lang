// The directories a policy's `dir` patterns stand for, resolved once when a
// run's context is built. The matcher in policy.ts takes the resolved
// strings and touches no file, because it runs while an interrupt is being
// answered and a disk read does not belong on that path. The host's
// `system.realDir` and `system.installDir` are synchronous for the same
// reason.

import { defaultHost } from "#default-host";
import type { Host } from "../host/host.js";
import { agentHomeDir } from "./agentHome.js";
import {
  substituteAgentHome,
  substituteDot,
  substituteInstallDir,
  type PolicyDirs,
} from "./policy.js";

export type { PolicyDirs } from "./policy.js";

/** Resolve the three directories through `host`, each spelled the way file
 *  effects spell the paths in their payloads: the real path when the
 *  directory exists, its lexical spelling when it does not, so matching
 *  stays as it was rather than failing every rule. */
export function resolvePolicyDirs(host: Host): PolicyDirs {
  return {
    cwd: host.system.realDir(host.system.cwd()),
    agentHome: host.system.realDir(agentHomeDir(host)),
    agencyInstallDir: host.system.installDir(),
  };
}

/** `substituteDot` over the real path of `cwd`. For tests, which inject
 *  the cwd. A cwd that cannot be resolved keeps its lexical spelling. */
export function resolveDotDirPattern(
  pattern: string,
  cwd: string = defaultHost().system.cwd(),
): string {
  return substituteDot(pattern, defaultHost().system.realDir(cwd));
}

/** `substituteInstallDir` over the install root, or the pattern as written
 *  when the root cannot be found. For tests, which inject the root. */
export function expandAgencyInstallDir(
  pattern: string,
  root: () => string = () => {
    const dir = defaultHost().system.installDir();
    if (dir === null) {
      throw new Error("the agency-lang package is not installed on disk");
    }
    return dir;
  },
): string {
  let resolved: string | null;
  try {
    resolved = root();
  } catch {
    resolved = null;
  }
  return substituteInstallDir(pattern, resolved);
}

/** `substituteAgentHome` over the real spelling of the agent home. For
 *  tests, which inject the home. */
export function expandAgentHomeDir(
  pattern: string,
  home: () => string = () => {
    const host = defaultHost();
    return host.system.realDir(agentHomeDir(host));
  },
): string {
  return substituteAgentHome(pattern, home());
}
