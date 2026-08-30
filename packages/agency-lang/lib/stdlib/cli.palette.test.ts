import { describe, expect, it } from "vitest";
import { resolvePalette } from "./cli.js";

describe("resolvePalette", () => {
  it("returns a map unchanged", async () => {
    const map = { "/cost": "Show cost" };
    expect(await resolvePalette(map)).toBe(map);
  });

  it("calls a function for the map, so it reflects the running code", async () => {
    let calls = 0;
    const build = () => {
      calls += 1;
      return { "/rename": "Rename" };
    };
    expect(await resolvePalette(build)).toEqual({ "/rename": "Rename" });
    expect(calls).toBe(1);
  });
});
