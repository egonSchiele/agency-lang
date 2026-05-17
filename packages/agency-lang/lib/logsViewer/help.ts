// Help-screen content. Lives in its own module so it's easy to update
// when new bindings land and so the help text is testable.

export type BindingGroup = {
  heading: string;
  bindings: { keys: string; action: string }[];
};

export const HELP_GROUPS: BindingGroup[] = [
  {
    heading: "Navigate",
    bindings: [
      { keys: "j / Down / Ctrl+N", action: "next row" },
      { keys: "k / Up / Ctrl+P", action: "previous row" },
      { keys: "g", action: "first row" },
      { keys: "G", action: "last row" },
      { keys: "Tab / Shift+Tab", action: "next / previous trace" },
    ],
  },
  {
    heading: "Expand",
    bindings: [
      { keys: "l / Right / Enter", action: "expand or open payload pane" },
      { keys: "h / Left", action: "collapse or go to parent" },
      { keys: "e / E", action: "expand-all / collapse-all" },
      { keys: "p", action: "toggle payload pane" },
    ],
  },
  {
    heading: "Search",
    bindings: [
      { keys: "/", action: "search prompt" },
      { keys: "n", action: "next match" },
      { keys: "N", action: "previous match" },
      { keys: "Esc", action: "clear search / release focus" },
    ],
  },
  {
    heading: "Inspect",
    bindings: [
      { keys: "y", action: "copy JSON of focused node to clipboard" },
    ],
  },
  {
    heading: "Modes",
    bindings: [
      { keys: "f", action: "toggle follow mode" },
      { keys: "?", action: "toggle this help" },
      { keys: "q / Ctrl+C", action: "quit" },
    ],
  },
];

export function helpLines(): string[] {
  const lines: string[] = [];
  for (const group of HELP_GROUPS) {
    lines.push(`${group.heading}:`);
    for (const b of group.bindings) {
      lines.push(`  ${b.keys.padEnd(22)} ${b.action}`);
    }
    lines.push("");
  }
  lines.push("Press any key to close.");
  return lines;
}
