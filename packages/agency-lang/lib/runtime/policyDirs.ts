// The directories a policy's `dir` patterns stand for, resolved once when a
// run's context is built. The matcher in policy.ts takes the resolved
// strings and touches no file, because it runs while an interrupt is being
// answered and a disk read does not belong on that path.
//
// This file reads the disk through Node, so it is on the waiting list of
// eslint.node-exceptions.mjs.

import { realpathSync } from "fs";
import { defaultHost } from "#default-host";
import { getPackageRoot } from "../importPaths.js";
import type { Host } from "../host/host.js";
import { root } from "../stdlib/contained.js";
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
    cwd: realOrAsWritten(host.system.cwd()),
    agentHome: realOrAsWritten(agentHomeDir(host)),
    agencyInstallDir: installDirOrNull(),
  };
}

function realOrAsWritten(dir: string): string {
  try {
    return root(dir).real;
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

/** `substituteDot` over the real path of `cwd`. For tests, which inject
 *  the cwd. A cwd that cannot be resolved keeps its lexical spelling. */
export function resolveDotDirPattern(pattern: string, cwd: string = process.cwd()): string {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  return substituteDot(pattern, realCwd);
}

/** `substituteInstallDir` over the install root, or the pattern as written
 *  when the root cannot be found. For tests, which inject the root. */
export function expandAgencyInstallDir(
  pattern: string,
  root: () => string = getPackageRoot,
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
  home: () => string = () => realOrAsWritten(agentHomeDir(defaultHost())),
): string {
  return substituteAgentHome(pattern, home());
}
