import { describe, expect, it } from "vitest";
import { resolveForwardedArgs } from "./forwardedArgs.js";

const AGENCY_FLAGS = ["--max-cost", "--policy", "-i", "--interactive", "-c"];

describe("resolveForwardedArgs", () => {
  it("forwards a program's own flags untouched", () => {
    expect(resolveForwardedArgs(["--name", "alice"], AGENCY_FLAGS)).toEqual({
      args: ["--name", "alice"],
    });
  });

  it("removes one separator so the program never sees it", () => {
    expect(
      resolveForwardedArgs(["--", "--name", "alice"], AGENCY_FLAGS),
    ).toEqual({ args: ["--name", "alice"] });
  });

  it("keeps a second separator, which belongs to the program", () => {
    expect(
      resolveForwardedArgs(["--", "a", "--", "b"], AGENCY_FLAGS),
    ).toEqual({ args: ["a", "--", "b"] });
  });

  it("reports an agency flag that landed after the filename", () => {
    expect(
      resolveForwardedArgs(["--max-cost", "5"], AGENCY_FLAGS),
    ).toEqual({ args: ["--max-cost", "5"], misplaced: "--max-cost" });
  });

  it("recognizes the attached-value spelling", () => {
    expect(resolveForwardedArgs(["--policy=strict"], AGENCY_FLAGS)).toEqual({
      args: ["--policy=strict"],
      misplaced: "--policy",
    });
  });

  it("recognizes a short flag", () => {
    expect(resolveForwardedArgs(["-i"], AGENCY_FLAGS)).toEqual({
      args: ["-i"],
      misplaced: "-i",
    });
  });

  it("leaves an agency flag alone once the user claims it with a separator", () => {
    expect(
      resolveForwardedArgs(["--", "--max-cost", "5"], AGENCY_FLAGS),
    ).toEqual({ args: ["--max-cost", "5"] });
  });

  it("does not mistake a positional word for a flag", () => {
    expect(resolveForwardedArgs(["policy", "hello"], AGENCY_FLAGS)).toEqual({
      args: ["policy", "hello"],
    });
  });
});
