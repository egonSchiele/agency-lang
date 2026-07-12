// Regenerates docs/site/diagnostics/ from the diagnostics registry +
// explanations table. A BUILD script (compiled to dist/scripts/ like
// stdlib-stamp), invoked from the Makefile — never a user command. One fast
// node invocation, no stamp machinery: it wipes and rewrites the whole dir.
import * as fs from "fs";
import * as path from "path";
import { generateDiagnosticsPages } from "@/cli/diagnosticsDocs.js";
import { safeDeleteDirectory } from "@/utils.js";

const outDir = process.argv[2];
if (!outDir) {
  console.error("usage: generateDiagnosticsDocs <output-dir>");
  process.exit(1);
}
// safeDeleteDirectory confines deletes to the project root (checkInsideProject),
// so a mistyped argv[2] can't wipe an arbitrary path. Fail fast if it refuses.
if (fs.existsSync(outDir)) {
  const del = safeDeleteDirectory(outDir, false);
  if (!del.success) {
    console.error(`Refusing to regenerate '${outDir}': ${del.message}`);
    process.exit(1);
  }
}
fs.mkdirSync(outDir, { recursive: true });
const pages = generateDiagnosticsPages();
for (const { relPath, contents } of pages) {
  fs.writeFileSync(
    path.join(outDir, relPath),
    contents.endsWith("\n") ? contents : contents + "\n",
  );
}
console.log(`Wrote ${pages.length} diagnostics pages to ${outDir}`);
