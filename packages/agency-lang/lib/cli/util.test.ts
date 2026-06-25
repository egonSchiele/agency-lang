import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgencyNode } from "./util.js";

// Agency files must run from inside the package tree so the compiled module can
// resolve the `agency-lang` runtime (see CLAUDE.md: cannot run agents from /tmp).
describe("runAgencyNode", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(process.cwd(), "run-node-test-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("runs a node and returns its value as data, with no test-LLM env required", async () => {
    const agent = path.join(dir, "const.agency");
    fs.writeFileSync(agent, "node main() {\n  return 42\n}\n");
    const { data } = await runAgencyNode({
      config: {}, agencyFile: agent, nodeName: "main", hasArgs: false, argsString: "", scratchDir: dir, quietCompile: true,
    });
    expect(data).toBe(42);
  });
});
