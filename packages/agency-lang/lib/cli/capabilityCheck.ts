// The runner's half of the capability log (lib/runtime/capabilityLog.ts):
// what a test's subprocess asked the host for, against the @capabilities
// tags of the effects it raised.

import type { Capability } from "../host/host.js";
import type { AgencyConfig } from "../config/config.js";
import { SymbolTable } from "../symbolTable.js";
import { readCapabilities } from "../utils/capabilitiesTag.js";
import type { CapabilityLogEntry } from "../runtime/capabilityLog.js";

/** The capabilities the check covers. `terminal` is left out because
 *  `print` and `input` raise no effect and nearly every test prints;
 *  `env` because `env()` is read before many raises through its own
 *  effect; `llm` because both platforms have it. */
export const CHECKED_CAPABILITIES: Capability[] = [
  "fileRead",
  "fileWrite",
  "network",
  "subprocess",
];

/** The tagged capabilities of every effect declared in the import closure
 *  of `file`, the stdlib included. */
export function effectCapabilitiesFor(
  file: string,
  config: AgencyConfig,
): Record<string, Capability[]> {
  const byEffect: Record<string, Capability[]> = Object.create(null);
  for (const { decl } of SymbolTable.build(file, config).allEffectDeclarations()) {
    const read = readCapabilities(decl.tags);
    if (!read.tagged) {
      continue;
    }
    const known = byEffect[decl.effect] ?? [];
    byEffect[decl.effect] = [
      ...known,
      ...read.capabilities.filter((capability) => !known.includes(capability)),
    ];
  }
  return byEffect;
}

/** What the log says about one test case, against the tags. `wrongTags`
 *  is a capability the host was asked for while some effect was raised
 *  and none of the raised effects is tagged with it: a tag is missing
 *  the name. `silentUses` is a capability the host was asked for by a
 *  case that raised no effect at all: a function that uses the host and
 *  raises nothing, which is a decision about that function, not about a
 *  tag (docs/dev/language/capabilities.md lists them). Only the first
 *  fails the case. */
export type CapabilityCheckResult = { wrongTags: string[]; silentUses: string[] };

export function checkCapabilityLog(
  entries: CapabilityLogEntry[],
  tagsByEffect: Record<string, Capability[]>,
): CapabilityCheckResult {
  const raised: string[] = [];
  const functionsByCapability: Record<string, string[]> = {};
  for (const entry of entries) {
    if (entry.kind === "raise") {
      if (!raised.includes(entry.effect)) {
        raised.push(entry.effect);
      }
      continue;
    }
    if (!CHECKED_CAPABILITIES.includes(entry.capability)) {
      continue;
    }
    const functions = (functionsByCapability[entry.capability] ??= []);
    if (!functions.includes(entry.functionName)) {
      functions.push(entry.functionName);
    }
  }
  const covered = raised.flatMap((effect) => tagsByEffect[effect] ?? []);
  const result: CapabilityCheckResult = { wrongTags: [], silentUses: [] };
  for (const capability of CHECKED_CAPABILITIES) {
    const functions = functionsByCapability[capability];
    if (functions === undefined || covered.includes(capability)) {
      continue;
    }
    if (raised.length === 0) {
      result.silentUses.push(
        `${functions.join(", ")} used the ${capability} capability, and no effect was raised`,
      );
    } else {
      result.wrongTags.push(
        `${functions.join(", ")} used the ${capability} capability, and no raised effect is tagged with it (raised: ${raised.join(", ")})`,
      );
    }
  }
  return result;
}
