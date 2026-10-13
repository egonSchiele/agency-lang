/**
 * What each effect needs from the host, per effect, at run time. Filled by
 * generated code: each `effect` declaration carrying a `@capabilities` tag
 * compiles to one `__registerEffectCapabilities` call at module JS-load,
 * the way an `@always` tag registers its scope (alwaysScope.ts). Read by
 * `interruptWithHandlers` before any handler is consulted, so an effect the
 * run's host cannot serve is rejected before anyone is asked to approve
 * it. See docs/dev/language/capabilities.md.
 *
 * Process-wide and derived from code. Never checkpointed: a resume
 * re-imports the modules and re-registers.
 */

import type { Capability, Host } from "../host/host.js";

// Null prototype: effect names are user-controlled strings.
const capabilities: Record<string, Capability[]> = Object.create(null);

/** Same capabilities, in any order, each counted once. The typechecker and
 *  the registry share this so "these two declarations agree" means one
 *  thing. */
export function sameCapabilities(a: Capability[], b: Capability[]): boolean {
  return a.length === b.length && a.every((capability) => b.includes(capability));
}

function describe(list: Capability[]): string {
  return `[${list.join(", ")}]`;
}

export function __registerEffectCapabilities(effect: string, needed: Capability[]): void {
  // An empty list says nothing, so it cannot contradict a list already
  // registered.
  if (needed.length === 0) {
    return;
  }
  const existing = capabilities[effect] ?? [];
  if (sameCapabilities(existing, needed)) {
    return;
  }
  if (existing.length > 0) {
    throw new Error(
      `Effect '${effect}' registered two different @capabilities lists: ${describe(existing)} and ${describe(needed)}`,
    );
  }
  capabilities[effect] = [...needed];
}

export function effectCapabilitiesFor(effect: string): Capability[] {
  return [...(capabilities[effect] ?? [])];
}

/** The first capability `effect` needs that `host` lacks, or null when the
 *  host can serve it. An effect nothing registered needs nothing. */
export function missingCapabilityFor(host: Host, effect: string): Capability | null {
  for (const capability of effectCapabilitiesFor(effect)) {
    if (!host.capabilities.includes(capability)) {
      return capability;
    }
  }
  return null;
}
