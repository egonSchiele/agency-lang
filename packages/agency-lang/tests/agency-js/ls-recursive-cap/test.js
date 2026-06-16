import { main } from "./agent.js";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Build a tree with real source files plus the heavyweight dirs a
// recursive `ls` must skip (node_modules with many files, .git).
const dir = mkdtempSync(join(tmpdir(), "ls-cap-"));
mkdirSync(join(dir, "src"));
writeFileSync(join(dir, "src", "a.ts"), "a");
writeFileSync(join(dir, "src", "b.ts"), "b");
writeFileSync(join(dir, "src", "c.ts"), "c");
mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
for (let i = 0; i < 50; i++) {
  writeFileSync(join(dir, "node_modules", "pkg", `f${i}.js`), "x");
}
mkdirSync(join(dir, ".git"));
writeFileSync(join(dir, ".git", "config"), "x");

try {
  const result = await main({ dir });
  writeFileSync("__result.json", JSON.stringify(result.data, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
