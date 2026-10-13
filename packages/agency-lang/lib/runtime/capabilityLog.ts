// The capability log: how the test runner checks a @capabilities tag
// against the code behind it. `agency test --check-capabilities` names a
// file in the AGENCY_CAPABILITY_LOG setting of each test's subprocess. In
// that process the default Node host appends a line for every capability
// function it runs (lib/host/node/default.node.ts), and `enterCallable`
// appends a line when a function or node starts, with its own tag, and one
// when it ends (lib/runtime/capabilities.ts). When the subprocess exits, the
// runner replays the lines: a host use is covered when some function that
// has entered and not yet exited declares the capability. See
// docs/dev/language/capabilities.md.

import type { Capability, Host } from "../host/host.js";
import { openLineSink } from "#platform";

export const CAPABILITY_LOG_SETTING = "AGENCY_CAPABILITY_LOG";

export type CapabilityLogEntry =
  | { kind: "use"; functionName: string; capability: Capability }
  | { kind: "enter"; name: string; capabilities: Capability[] }
  | { kind: "exit"; name: string };

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

// One sink per file, so a run that enters many functions opens the file's
// directory once.
// Null prototype: the path is a setting, which a program can set.
const sinks: Record<string, (line: string) => void> = Object.create(null);

/** The function that appends a line to the capability log the host's
 *  settings name, or null when no log is named. Every run with no log
 *  pays one settings read per callable entry and nothing more. */
export function capabilityLogWriter(host: Host): ((entry: CapabilityLogEntry) => void) | null {
  const file = host.settings.read(CAPABILITY_LOG_SETTING);
  if (file === null || file === "") {
    return null;
  }
  sinks[file] ??= openLineSink(file);
  const sink = sinks[file];
  return (entry) => sink(formatCapabilityLogLine(entry));
}
