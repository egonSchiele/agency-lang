import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { agentClosure, agentClosureBaseDir } from "./closure.js";

describe("agentClosure", () => {
  function closureProject(): string {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "closure-"));
    fs.mkdirSync(path.join(projectDir, "lib"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "lib", "helper.agency"), "export def helper(): string { return \"hi\" }\n");
    fs.writeFileSync(path.join(projectDir, "agent.agency"), "import { helper } from \"./lib/helper.agency\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "unrelated.agency"), "node main() {}\n");
    return projectDir;
  }

  it("returns the entry plus every transitively imported .agency file, and agrees with agentClosureBaseDir", () => {
    const projectDir = closureProject();
    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", path.join("lib", "helper.agency")]);
    expect(closure.baseDir).toBe(agentClosureBaseDir(path.join(projectDir, "agent.agency")));
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("includes TypeScript interop files, transitively, resolving ./x.js to x.ts", () => {
    const projectDir = closureProject();
    // agent imports ./greet.js (the interop form); greet.ts exists and imports ./util.ts
    fs.writeFileSync(path.join(projectDir, "agent.agency"),
      "import { helper } from \"./lib/helper.agency\"\nimport { greet } from \"./greet.js\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "greet.ts"),
      "import { upper } from \"./util.js\";\nexport function greet(name: string): string { return upper(name); }\n");
    fs.writeFileSync(path.join(projectDir, "util.ts"),
      "export function upper(value: string): string { return value.toUpperCase(); }\n");

    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", "greet.ts", path.join("lib", "helper.agency"), "util.ts"]);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it("leaves bare package imports external (no node_modules files in the closure)", () => {
    const projectDir = closureProject();
    fs.writeFileSync(path.join(projectDir, "agent.agency"),
      "import { z } from \"./schema.js\"\nnode main() {}\n");
    fs.writeFileSync(path.join(projectDir, "schema.ts"),
      "import { z } from \"zod\";\nexport { z };\n");

    const closure = agentClosure(path.join(projectDir, "agent.agency"));

    const rels = closure.files.map((file) => path.relative(closure.baseDir, file)).sort();
    expect(rels).toEqual(["agent.agency", "schema.ts"]);
    fs.rmSync(projectDir, { recursive: true, force: true });
  });
});
