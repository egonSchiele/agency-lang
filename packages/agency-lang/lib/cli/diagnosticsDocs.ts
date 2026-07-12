import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
} from "@/typeChecker/diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "@/typeChecker/diagnosticExplanations.js";

type Page = { relPath: string; contents: string };

function codesForCategory(prefix: string) {
  return Object.entries(DIAGNOSTICS)
    .filter(([, e]) => categoryForCode(e.code)?.prefix === prefix)
    .sort(([, a], [, b]) => a.code.localeCompare(b.code));
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function indexPage(): string {
  const lines = [
    "---",
    'name: "Diagnostics"',
    "---",
    "",
    "# Diagnostic codes",
    "",
    "Every type-checker error and warning carries a stable `AG####` code.",
    "Look one up with `agency explain <code>` (e.g. `agency explain AG2005`),",
    "or suppress one on the next line with `// @tc-ignore AG####`.",
    "",
  ];
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    const entries = codesForCategory(cat.prefix);
    if (entries.length === 0) continue;
    lines.push(`## ${cat.title}`, "");
    lines.push("| Code | Message |", "| --- | --- |");
    for (const [, e] of entries) {
      const anchor = e.code.toLowerCase();
      lines.push(`| [${e.code}](${cat.slug}.md#${anchor}) | ${escapeCell(e.message)} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function categoryPage(cat: (typeof DIAGNOSTIC_CATEGORIES)[number]): string {
  const lines = ["---", `name: "${cat.title}"`, "---", "", `# ${cat.title}`, ""];
  for (const [name, e] of codesForCategory(cat.prefix)) {
    // Explicit anchor: VitePress slugifies heading IDs from the FULL heading
    // text ("## AG2001 — Type ..."), so the index's `#ag2001` fragment would
    // not match. This bare-code anchor is what the index links resolve to.
    lines.push(`<a id="${e.code.toLowerCase()}"></a>`, "");
    lines.push(`## ${e.code} — ${e.message}`, "");
    lines.push(`*Default severity: ${e.severity}.*`, "");
    lines.push(DIAGNOSTIC_EXPLANATIONS[name as keyof typeof DIAGNOSTIC_EXPLANATIONS], "");
  }
  return lines.join("\n");
}

/** All diagnostics pages as in-memory {relPath, contents}. The build script
 *  writes them; tests assert on them without touching the filesystem. */
export function generateDiagnosticsPages(): Page[] {
  return [
    { relPath: "index.md", contents: indexPage() },
    ...DIAGNOSTIC_CATEGORIES.map((cat) => ({
      relPath: `${cat.slug}.md`,
      contents: categoryPage(cat),
    })),
  ];
}
