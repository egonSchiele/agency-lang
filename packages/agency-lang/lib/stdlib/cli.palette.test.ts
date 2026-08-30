import { describe, expect, it } from "vitest";
import { _setSlashPalette, _slashPalette } from "./cli.js";

describe("_slashPalette", () => {
  it("uses the registered palette when repl() passed none", () => {
    _setSlashPalette({ "/rename": "Rename", cost: "not a slash command" });
    expect(_slashPalette(null)).toEqual([["/rename", "Rename"]]);
  });

  it("prefers the palette passed to repl()", () => {
    _setSlashPalette({ "/rename": "Rename" });
    expect(_slashPalette({ "/cost": "Cost" })).toEqual([["/cost", "Cost"]]);
  });
});
