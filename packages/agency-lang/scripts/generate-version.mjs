// Writes package.json's version into lib/stdlib/version.ts as VERSION, the
// one version agency-lang reports: `agency --version`, trace headers, the
// MCP server and `agency serve`. It is a constant rather than a read of
// package.json because runtime code that imports it may run in a browser.
// `make build` runs this before compiling. CI fails when the committed file
// differs from the one `make` writes, so a version bump commits it too.
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(packageRoot, "lib", "stdlib", "version.ts");
const { version } = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));

const content =
  "// Generated from package.json by scripts/generate-version.mjs. Do not edit.\n" +
  `export const VERSION = ${JSON.stringify(version)};\n`;

let current = null;
try {
  current = readFileSync(target, "utf8");
} catch {
  // Not written yet.
}
// Unchanged content is left alone, so incremental builds stay incremental.
if (current !== content) writeFileSync(target, content);
