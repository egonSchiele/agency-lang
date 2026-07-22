import {
  DIAGNOSTICS,
  DIAGNOSTIC_CATEGORIES,
  categoryForCode,
} from "@/typeChecker/diagnostics.js";
import { DIAGNOSTIC_EXPLANATIONS } from "@/typeChecker/diagnosticExplanations.js";
import { LINT_DIAGNOSTICS } from "@/linter/diagnostics.js";
import { LINT_EXPLANATIONS } from "@/linter/diagnosticExplanations.js";

type Page = { relPath: string; contents: string };

function codesForCategory(prefix: string) {
  // Retired diagnostics keep their registry entry (the code stays
  // reserved and `agency explain` still answers for it) but drop out of
  // the public docs pages.
  return Object.entries(DIAGNOSTICS)
    .filter(([, e]) => !("retired" in e))
    .filter(([, e]) => categoryForCode(e.code)?.prefix === prefix)
    .sort(([, a], [, b]) => a.code.localeCompare(b.code));
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Render a message template as literal text for a VitePress page. Templates
 * contain characters VitePress/Vue would otherwise interpret: `{{ … }}` reads
 * as a Vue interpolation (hard build error) and `<...>` reads as an HTML tag.
 * Collapse the template's literal-brace escape (`{{ }}` -> `{ }`) so the real
 * braces show, then HTML-escape every metacharacter so the whole string is
 * inert text. Order matters: escape `&` before introducing entities.
 */
function messageForMd(msg: string): string {
  return msg
    .replace(/\{\{/g, "{")
    .replace(/\}\}/g, "}")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\{/g, "&#123;")
    .replace(/\}/g, "&#125;");
}

function indexPage(): string {
  const lines = [
    "---",
    'name: "Diagnostics"',
    "---",
    "",
    "# Diagnostic codes",
    "",
    "Every type-checker error and warning carries a stable `AG####` code, and",
    "every `agency lint` finding a stable `AL####` code.",
    "Look one up with `agency explain <code>` (e.g. `agency explain AG2005`),",
    "or suppress a type-checker one on the next line with `// @tc-ignore AG####`.",
    "",
  ];
  for (const cat of DIAGNOSTIC_CATEGORIES) {
    const entries = codesForCategory(cat.prefix);
    if (entries.length === 0) continue;
    lines.push(`## ${cat.title}`, "");
    lines.push("| Code | Message |", "| --- | --- |");
    for (const [, e] of entries) {
      const anchor = e.code.toLowerCase();
      lines.push(`| [${e.code}](${cat.slug}.md#${anchor}) | ${escapeCell(messageForMd(e.message))} |`);
    }
    lines.push("");
  }
  lines.push("## Lint", "");
  lines.push("| Code | Message |", "| --- | --- |");
  for (const [, e] of lintEntries()) {
    lines.push(`| [${e.code}](lint.md#${e.code.toLowerCase()}) | ${escapeCell(messageForMd(e.message))} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Active lint codes, sorted. The lint registry is one flat namespace (no
 *  category table — a deliberate divergence from the type checker), so all
 *  AL codes share the single lint.md page. */
function lintEntries() {
  return Object.entries(LINT_DIAGNOSTICS)
    .filter(([, e]) => !("retired" in e))
    .sort(([, a], [, b]) => a.code.localeCompare(b.code));
}

function lintPage(): string {
  const lines = [
    "---",
    'name: "Lint"',
    "---",
    "",
    "# Lint",
    "",
    "Findings from `agency lint` and the editor (grayed-out code, quick",
    "fixes). Lint findings are style and hygiene notices, not errors: the",
    "program still compiles and runs, and `agency lint` exits 0 on",
    "hint-level findings so they never fail CI.",
    "",
  ];
  for (const [name, e] of lintEntries()) {
    lines.push(`<a id="${e.code.toLowerCase()}"></a>`, "");
    lines.push(`## ${e.code} — ${messageForMd(e.message)}`, "");
    lines.push(`*Default severity: ${e.severity}.*`, "");
    lines.push(LINT_EXPLANATIONS[name as keyof typeof LINT_EXPLANATIONS], "");
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
    lines.push(`## ${e.code} — ${messageForMd(e.message)}`, "");
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
    { relPath: "lint.md", contents: lintPage() },
  ];
}
