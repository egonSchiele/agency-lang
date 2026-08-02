import { describe, expect, it } from "vitest";

import { LoadingScreen } from "./loadingScreen.js";
import { screenText } from "./viewTestUtils.js";

const viewport = { rows: 24, cols: 80 };

describe("LoadingScreen", () => {
  it("renders the ticking counter", () => {
    const view = new LoadingScreen();
    expect(screenText(view.render(viewport))).toContain("Loading runs…");
    view.setProgress({ kind: "progress", phase: "summary", completed: 40, total: 210 });
    expect(screenText(view.render(viewport))).toContain("Loading runs… 40/210");
  });

  it("q quits during loading; other keys do nothing", () => {
    const view = new LoadingScreen();
    expect(view.handleKey({ key: "q" })).toEqual({ kind: "quit" });
    expect(view.handleKey({ key: "j" })).toEqual({ kind: "none" });
  });
});
