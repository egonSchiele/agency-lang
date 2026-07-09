import { describe, expect, it } from "vitest";

import { buildDoctorArgs } from "./doctor.js";

describe("buildDoctorArgs", () => {
  it("appends --trace / --log-file before the -- terminator", () => {
    const args = buildDoctorArgs({
      file: "x.agency",
      symptom: "boom",
      trace: "t.trace",
      logFile: "l.jsonl",
    });
    const dashDash = args.indexOf("--");
    expect(dashDash).toBeGreaterThan(-1);
    expect(args.indexOf("--trace")).toBeGreaterThan(-1);
    expect(args.indexOf("--trace")).toBeLessThan(dashDash);
    expect(args.indexOf("--log-file")).toBeLessThan(dashDash);
    expect(args.slice(args.indexOf("--trace"), args.indexOf("--trace") + 2)).toEqual([
      "--trace",
      "t.trace",
    ]);
  });

  it("bare --trace appends just the flag before --", () => {
    const args = buildDoctorArgs({ file: "x.agency", trace: true });
    expect(args.filter((a) => a === "--trace")).toHaveLength(1);
    expect(args.indexOf("--trace")).toBeLessThan(args.indexOf("--"));
    // No stray value token after a bare --trace.
    expect(args[args.indexOf("--trace") + 1]).toBe("--");
  });

  it("omits the debug flags entirely when not requested", () => {
    const args = buildDoctorArgs({ file: "x.agency", symptom: "boom" });
    expect(args).not.toContain("--trace");
    expect(args).not.toContain("--log-file");
    expect(args[args.length - 2]).toBe("--");
  });
});
