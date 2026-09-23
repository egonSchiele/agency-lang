import { describe, expect, it } from "vitest";
import { escOutcome, type EscState } from "./escLadder.js";

const base: EscState = {
  tooNarrow: false,
  helpOpen: false,
  overlayOpen: false,
  overlayEscaped: () => false,
  screenEscaped: () => false,
  activeScreen: "trace",
  embedded: false,
  tracePickerOpen: false,
  tracePickerAvailable: false,
};

describe("escOutcome walks the ladder top down", () => {
  it("help first", () => {
    expect(escOutcome({ ...base, helpOpen: true, overlayOpen: true })).toBe("closeHelp");
  });
  it("an overlay undoes its own state before it closes", () => {
    expect(escOutcome({ ...base, overlayOpen: true, overlayEscaped: () => true })).toBe("overlay");
    expect(escOutcome({ ...base, overlayOpen: true })).toBe("popOverlay");
  });
  it("then whatever the screen itself can undo", () => {
    expect(escOutcome({ ...base, screenEscaped: () => true })).toBe("screen");
  });
  it("then home to the overview", () => {
    expect(escOutcome(base)).toBe("goOverview");
  });
  it("on the overview, an embedded viewer returns to its host", () => {
    expect(escOutcome({ ...base, activeScreen: "overview", embedded: true })).toBe("back");
  });
  it("on the overview, standalone, Esc does nothing. It never quits.", () => {
    expect(escOutcome({ ...base, activeScreen: "overview" })).toBe("nothing");
  });
  it("does not ask the screen while an overlay is open", () => {
    const asked: string[] = [];
    escOutcome({ ...base, overlayOpen: true, screenEscaped: () => asked.push("screen") > 0 });
    expect(asked).toEqual([]);
  });
  it("a terminal too narrow to draw has nothing to undo: back when embedded, else nothing", () => {
    expect(escOutcome({ ...base, tooNarrow: true, embedded: true, helpOpen: true })).toBe("back");
    expect(escOutcome({ ...base, tooNarrow: true })).toBe("nothing");
  });
});
