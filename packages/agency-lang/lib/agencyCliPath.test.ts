import * as path from "path";
import { describe, expect, it } from "vitest";
import { agencyCliPath } from "./agencyCliPath.js";
import { getPackageRoot } from "./importPaths.js";

const OWN_BUILD = path.join(getPackageRoot(), "dist", "scripts", "agency.js");

describe("agencyCliPath", () => {
  it("is the script a command was started with", () => {
    const script = path.join("/opt", "agency", "dist", "scripts", "agency.js");
    expect(agencyCliPath(script)).toBe(script);
  });

  // `agency run agency.agency` runs a compiled file called `agency.js`.
  // Taking it for the command line would make `spawn` run the program
  // itself again.
  it("is the package's build for a compiled program called agency.js", () => {
    expect(agencyCliPath(path.join("/home", "me", "project", "agency.js"))).toBe(OWN_BUILD);
  });

  it("is the package's build for any other script", () => {
    expect(agencyCliPath(path.join("/home", "me", "project", "report.js"))).toBe(OWN_BUILD);
    expect(agencyCliPath("")).toBe(OWN_BUILD);
  });
});
