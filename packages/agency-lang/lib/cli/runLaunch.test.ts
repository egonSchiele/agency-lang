import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeDeleteDirectoryWithin } from "@/utils.js";
import { runLaunchFrom, seedSource } from "./runLaunch.js";

describe("runLaunchFrom", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agency-launch-")));
  });
  afterEach(() => {
    safeDeleteDirectoryWithin(os.tmpdir(), dir);
  });

  it("titles the run after the input file, or after --name", () => {
    expect(runLaunchFrom({}, "agents/report.agency", dir)).toEqual({
      title: "agency run report.agency",
    });
    expect(runLaunchFrom({ name: "nightly" }, "agents/report.agency", dir)).toEqual({
      title: "agency run nightly",
    });
  });

  it("makes the output file of --detach absolute", () => {
    expect(runLaunchFrom({ detach: "out.log" }, "a.agency", dir)).toEqual({
      title: "agency run a.agency",
      detachedOutputFile: path.join(dir, "out.log"),
    });
  });

  it("carries a seed file by its absolute path", () => {
    fs.writeFileSync(path.join(dir, "seed.json"), "[]");
    expect(runLaunchFrom({ messages: "seed.json" }, "a.agency", dir)).toMatchObject({
      seedMessages: path.join(dir, "seed.json"),
    });
  });

  it("refuses a seed file that is missing, is not JSON, or is not a list", () => {
    fs.writeFileSync(path.join(dir, "text.json"), "hello");
    fs.writeFileSync(path.join(dir, "object.json"), "{}");
    expect(seedSource("missing.json", false, dir)).toMatchObject({
      refused: expect.stringContaining("could not read"),
    });
    expect(seedSource("text.json", false, dir)).toMatchObject({
      refused: expect.stringContaining("is not valid JSON"),
    });
    expect(seedSource("object.json", false, dir)).toMatchObject({
      refused: expect.stringContaining("does not hold a JSON list"),
    });
    expect(runLaunchFrom({ messages: "object.json" }, "a.agency", dir)).toHaveProperty("refused");
  });

  it("refuses a seed file that is a symbolic link", () => {
    fs.writeFileSync(path.join(dir, "real.json"), "[]");
    fs.symlinkSync(path.join(dir, "real.json"), path.join(dir, "link.json"));
    expect(seedSource("link.json", false, dir)).toMatchObject({
      refused: expect.stringContaining("symbolic link"),
    });
  });

  it("takes the seed from standard input only for a detached program", () => {
    expect(seedSource("-", true, dir)).toBe("-");
    expect(seedSource("-", false, dir)).toMatchObject({
      refused: expect.stringContaining("needs --detach"),
    });
    expect(runLaunchFrom({ messages: "-", detach: "out.log" }, "a.agency", dir)).toMatchObject({
      seedMessages: "-",
    });
  });
});
