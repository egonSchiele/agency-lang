// The capability log: how the test runner checks a @capabilities tag
// against the code behind it. `agency test --check-capabilities` names a
// file in the AGENCY_CAPABILITY_LOG setting of each test's subprocess. In
// that process the default Node host appends a line for every capability
// function it runs (lib/host/node/default.node.ts), and the runtime appends
// a line for every effect raised (`recordRaise`, called from
// interruptWithHandlers). When the subprocess exits, the runner reads the
// file and compares the two lists with the tags: a capability the host
// was asked for that no raised effect is tagged with fails the test. See
// docs/dev/language/capabilities.md.

import type { Capability, Host } from "../host/host.js";
import { openLineSink } from "#platform";

export const CAPABILITY_LOG_SETTING = "AGENCY_CAPABILITY_LOG";

export type CapabilityLogEntry =
  { kind: "use"; functionName: string; capability: Capability } | { kind: "raise"; effect: string };

export function formatCapabilityLogLine(entry: CapabilityLogEntry): string {
  if (entry.kind === "use") {
    return `use ${entry.functionName} ${entry.capability}`;
  }
  return `raise ${entry.effect}`;
}

/** The entries in a log file's text. A line that is not one of the two
 *  shapes is skipped, so a half-written last line cannot break the check. */
export function parseCapabilityLog(text: string): CapabilityLogEntry[] {
  const entries: CapabilityLogEntry[] = [];
  for (const line of text.split("\n")) {
    const words = line.split(" ");
    if (words[0] === "use" && words.length === 3) {
      entries.push({ kind: "use", functionName: words[1], capability: words[2] as Capability });
    } else if (words[0] === "raise" && words.length === 2) {
      entries.push({ kind: "raise", effect: words[1] });
    }
  }
  return entries;
}

// One sink per file, so a run that raises many effects opens the file's
// directory once.
// Null prototype: the path is a setting, which a program can set.
const sinks: Record<string, (line: string) => void> = Object.create(null);

/** Append a raise to the capability log, when the host's settings name
 *  one. Every other run does nothing here. */
export function recordRaise(host: Host, effect: string): void {
  const file = host.settings.read(CAPABILITY_LOG_SETTING);
  if (file === null || file === "") {
    return;
  }
  sinks[file] ??= openLineSink(file);
  sinks[file](formatCapabilityLogLine({ kind: "raise", effect }));
}
