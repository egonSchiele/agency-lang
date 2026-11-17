// The `PromptContext` for a program that shows an interrupt from outside a
// run, such as an app that got the interrupt back from
// `respondToInterrupts`. Inside a run, std::policy builds the context from
// the run itself (lib/stdlib/policy.ts).
import { defaultHost } from "#default-host";
import { allAlwaysScopes } from "./alwaysScope.js";
import type { ScopedField } from "./alwaysScope.js";
import { builtinEffectSets } from "./effectSets.js";
import type { PromptContext } from "./interruptPromptOptions.js";
import { resolvePolicyDirs } from "./policyDirs.js";

/** The declared scopes and built-in effect sets of this process, and the
 *  directories a policy's `dir` patterns stand for. `cwd` is the folder
 *  the run works in: what `.` means in a rule, and where the list of
 *  folders a rule may cover stops. It defaults to the process's own. */
export function promptContext(
  args: { cwd?: string; overrides?: Record<string, ScopedField[]> } = {},
): PromptContext {
  const host = defaultHost();
  const dirs = resolvePolicyDirs(host);
  return {
    overrides: args.overrides ?? {},
    registered: allAlwaysScopes(),
    sets: builtinEffectSets(),
    dirs: args.cwd === undefined ? dirs : { ...dirs, cwd: host.system.realDir(args.cwd) },
  };
}
