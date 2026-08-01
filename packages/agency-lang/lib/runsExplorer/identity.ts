// Agent identity: which name a run groups under, and which color that
// name paints. Pure projections — no I/O, no state.

export const MAX_IDENTITY_LABEL_CHARS = 24;

/** Frequency-ranked identity palette; "bright-cyan means the most-seen
 *  agent" holds across every screen, like the timeline's group colors. */
const IDENTITY_PALETTE = [
  "bright-cyan",
  "bright-magenta",
  "bright-yellow",
  "bright-green",
  "bright-blue",
  "cyan",
  "magenta",
  "yellow",
];

/** Precedence: the agent's own statelog name beats the eval label beats
 *  the launch command beats whatever the caller derived from the path. */
export function resolveAgentName(parts: {
  agentName?: string;
  agentLabel?: string;
  command?: string;
  fallback: string;
}): string {
  if (parts.agentName !== undefined && parts.agentName !== "") {
    return parts.agentName;
  }
  if (parts.agentLabel !== undefined && parts.agentLabel !== "") {
    return shortAgentLabel(parts.agentLabel);
  }
  if (parts.command !== undefined && parts.command !== "") {
    return shortAgentLabel(parts.command);
  }
  return parts.fallback;
}

/** Eval command labels are long argv strings; entry labels are absolute
 *  paths. Keep the human-meaningful bit of each (prototype finding:
 *  without this, most real rows read "/Users/someone…"). */
export function shortAgentLabel(label: string): string {
  const agentFlag = label.match(/agent --agent (\S+)/);
  if (label.includes("agency.js agent") || label.includes("agency agent")) {
    if (agentFlag !== null && agentFlag[1] !== undefined) {
      return `agency-agent(${agentFlag[1]})`;
    }
    return "agency-agent";
  }
  const agencyFile = label.match(/([^\s/]+\.agency)/);
  if (agencyFile !== null) {
    return agencyFile[1];
  }
  if (label.length > MAX_IDENTITY_LABEL_CHARS) {
    return `${label.slice(0, MAX_IDENTITY_LABEL_CHARS - 1)}…`;
  }
  return label;
}

/** Deterministic identity colors: rank names by how often they appear
 *  (ties broken by name) and assign the palette in order. Names past
 *  the palette get no color. */
export function agentColors(names: string[]): Record<string, string | undefined> {
  const counts: Record<string, number> = Object.create(null);
  for (const name of names) {
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => {
    if (b[1] !== a[1]) {
      return b[1] - a[1];
    }
    return a[0].localeCompare(b[0]);
  });
  const colors: Record<string, string | undefined> = Object.create(null);
  ranked.forEach(([name], rank) => {
    colors[name] = IDENTITY_PALETTE[rank];
  });
  return colors;
}
