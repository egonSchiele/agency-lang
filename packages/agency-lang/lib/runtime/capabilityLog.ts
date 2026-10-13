// The capability log: how the test runner checks a @capabilities tag
// against the code behind it. `agency test --check-capabilities` names a
// file in the AGENCY_CAPABILITY_LOG variable of each test's subprocess. The
// default Node host reads it once when it is built
// (lib/host/node/default.node.ts) and appends a line for every capability
// function it runs (`onUse`) and for every function or node that starts or
// ends (`onCallable`, called by lib/runtime/capabilities.ts). When the
// subprocess exits, the runner replays the lines: a host use is covered
// when some function that has entered and not yet exited declares the
// capability. See docs/dev/language/capabilities.md.

import type { CallableEvent, Capability } from "../host/host.js";

export const CAPABILITY_LOG_SETTING = "AGENCY_CAPABILITY_LOG";

export type CapabilityLogEntry =
  { kind: "use"; functionName: string; capability: Capability } | CallableEvent;

/** A function with no tag enters with this in place of its list, so every
 *  line has the same number of words. */
const NONE = "-";

export function formatCapabilityLogLine(entry: CapabilityLogEntry): string {
  if (entry.kind === "use") {
    return `use ${entry.functionName} ${entry.capability}`;
  }
  if (entry.kind === "enter") {
    const list = entry.capabilities.length === 0 ? NONE : entry.capabilities.join(",");
    return `enter ${entry.name} ${list}`;
  }
  return `exit ${entry.name}`;
}

/** The entries in a log file's text. A line that is not one of the three
 *  shapes is skipped, so a half-written last line cannot break the check. */
export function parseCapabilityLog(text: string): CapabilityLogEntry[] {
  const entries: CapabilityLogEntry[] = [];
  for (const line of text.split("\n")) {
    const words = line.split(" ");
    if (words[0] === "use" && words.length === 3) {
      entries.push({ kind: "use", functionName: words[1], capability: words[2] as Capability });
    } else if (words[0] === "enter" && words.length === 3) {
      const capabilities = words[2] === NONE ? [] : (words[2].split(",") as Capability[]);
      entries.push({ kind: "enter", name: words[1], capabilities });
    } else if (words[0] === "exit" && words.length === 2) {
      entries.push({ kind: "exit", name: words[1] });
    }
  }
  return entries;
}
