import { describe, it, expect } from "vitest";
import { _renderReadView } from "./readDialect.js";

describe("_renderReadView: cat", () => {
  it("prints the whole text as it is", () => {
    expect(_renderReadView("a\nb\n", { kind: "whole" })).toBe("a\nb\n");
    expect(_renderReadView("a\r\nb", { kind: "whole" })).toBe("a\r\nb");
  });

  it("numbers every line in six columns and a tab, as cat -n does", () => {
    expect(_renderReadView("a\nb\n", { kind: "numbered" })).toBe("     1\ta\n     2\tb\n");
  });

  it("numbers a last line with no newline, and keeps it without one", () => {
    expect(_renderReadView("a\nb", { kind: "numbered" })).toBe("     1\ta\n     2\tb");
  });

  it("prints nothing for an empty file", () => {
    expect(_renderReadView("", { kind: "numbered" })).toBe("");
  });

  it("numbers empty lines too", () => {
    expect(_renderReadView("a\n\nb\n", { kind: "numbered" })).toBe(
      "     1\ta\n     2\t\n     3\tb\n",
    );
  });
});

describe("_renderReadView: head", () => {
  it("prints the first lines, each with its newline", () => {
    expect(_renderReadView("a\nb\n", { kind: "head", lines: 1 })).toBe("a\n");
  });

  it("prints the whole text when it has fewer lines than asked for", () => {
    expect(_renderReadView("a\n", { kind: "head", lines: 5 })).toBe("a\n");
    expect(_renderReadView("a\nb", { kind: "head", lines: 5 })).toBe("a\nb");
  });

  it("prints nothing for an empty file", () => {
    expect(_renderReadView("", { kind: "head", lines: 3 })).toBe("");
  });
});

describe("_renderReadView: tail", () => {
  it("prints the last lines", () => {
    expect(_renderReadView("a\nb\n", { kind: "tail", lines: 1 })).toBe("b\n");
  });

  it("counts a last line with no newline as a line", () => {
    expect(_renderReadView("a\nb", { kind: "tail", lines: 1 })).toBe("b");
  });

  it("splits on the newline only, so a carriage return stays in its line", () => {
    expect(_renderReadView("a\r\nb\r\n", { kind: "tail", lines: 2 })).toBe("a\r\nb\r\n");
    expect(_renderReadView("a\r\nb\r\n", { kind: "tail", lines: 1 })).toBe("b\r\n");
  });

  it("prints the whole text when it has fewer lines than asked for", () => {
    expect(_renderReadView("a\n", { kind: "tail", lines: 5 })).toBe("a\n");
  });

  it("prints nothing for an empty file", () => {
    expect(_renderReadView("", { kind: "tail", lines: 3 })).toBe("");
  });
});
