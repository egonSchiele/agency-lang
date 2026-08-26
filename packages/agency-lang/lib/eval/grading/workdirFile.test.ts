import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, it } from "vitest";

import { readWorkdirFile } from "./workdirFile.js";

describe("readWorkdirFile", () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "workdir-"));
  fs.writeFileSync(path.join(workdir, "solution.agency"), "node main() {}");

  it("reads a file by its path relative to the workdir", () => {
    expect(readWorkdirFile(workdir, "solution.agency")).toBe("node main() {}");
  });

  it("is empty for a missing file, an empty workdir, or a path that escapes", () => {
    expect(readWorkdirFile(workdir, "missing.agency")).toBe("");
    expect(readWorkdirFile("", "solution.agency")).toBe("");
    expect(readWorkdirFile(workdir, "../" + path.basename(workdir) + "/solution.agency")).toBe(
      "node main() {}",
    );
    expect(readWorkdirFile(workdir, "../../etc/passwd")).toBe("");
  });
});
