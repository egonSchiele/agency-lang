// Regenerates docs/site/diagnostics/ from the diagnostics registry +
// explanations table. A BUILD script (compiled to dist/scripts/ like
// stdlib-stamp), invoked from the Makefile — never a user command. One fast
// node invocation, no stamp machinery: it wipes and rewrites the whole dir.
import * as fs from "fs";
import * as path from "path";
import { generateDiagnosticsPages } from "@/cli/diagnosticsDocs.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: generateDiagnosticsDocs <output-dir>");
  process.exit(1);
}
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const pages = generateDiagnosticsPages();
for (const { relPath, contents } of pages) {
  fs.writeFileSync(
    path.join(outDir, relPath),
    contents.endsWith("\n") ? contents : contents + "\n",
  );
}
console.log(`Wrote ${pages.length} diagnostics pages to ${outDir}`);
