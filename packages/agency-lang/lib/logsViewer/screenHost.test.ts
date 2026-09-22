import { describe, it, expect } from "vitest";
import { ScreenHost } from "./screenHost.js";
import type { Screen, ScreenName } from "./screens/screen.js";
import type { View } from "./views/view.js";
import { trace } from "./timeline/fixture.js";
function traceRoot(id: string) {
  return { ...trace([]), traceId: id, id: `trace-${id}` };
}
function fakeOverlay(viewName: View["viewName"]): View & { following: boolean } {
  const overlay = {
    viewName,
    following: false,
    handleKey: () => ({ kind: "none" as const }),
    render: () => ({ type: "text" as const, content: viewName }),
    setData: () => {},
    helpLines: () => [],
    notify: () => {},
    setFollowIndicator: (on: boolean) => {
      overlay.following = on;
    },
  };
  return overlay;
}
function fakeScreen(name: ScreenName, log: string[]): Screen & { focus: string | undefined } {
  const screen = {
    screenName: name,
    focus: undefined as string | undefined,
    handleKey: () => ({ kind: "none" as const }),
    render: () => ({ type: "text" as const, content: name }),
    setData: () => void log.push(`${name}.setData`),
    helpLines: () => [],
    notify: () => {},
    setFollowIndicator: () => {},
    focusId: () => screen.focus,
    setFocus: (id: string) => {
      screen.focus = id;
      log.push(`${name}.setFocus(${id})`);
    },
    setTrace: (traceId: string) => void log.push(`${name}.setTrace(${traceId})`),
    escape: () => false,
    applySearch: (query: string) => void log.push(`${name}.applySearch(${query})`),
  };
  return screen;
}

function makeHost(log: string[] = []) {
  const screens = {
    overview: fakeScreen("overview", log),
    trace: fakeScreen("trace", log),
    transcript: fakeScreen("transcript", log),
    timeline: fakeScreen("timeline", log),
  };
  return { host: new ScreenHost(screens, "trace", "T1"), screens, log };
}

describe("ScreenHost", () => {
  it("carries the focus from the screen it leaves to the one it enters", () => {
    const { host, screens, log } = makeHost();
    screens.trace.focus = "round:L:8";
    host.switchTo("timeline");
    expect(host.activeScreen()).toBe("timeline");
    expect(log).toContain("timeline.setFocus(round:L:8)");
  });

  it("an explicit focus wins over the carried one", () => {
    const { host, screens, log } = makeHost();
    screens.trace.focus = "old";
    host.switchTo("timeline", "new");
    expect(log).toContain("timeline.setFocus(new)");
  });

  it("with nothing focused it sets no focus", () => {
    const { host, log } = makeHost();
    host.switchTo("timeline");
    expect(log.filter((entry) => entry.includes("setFocus"))).toEqual([]);
  });

  it("switching screens closes overlays", () => {
    const { host } = makeHost();
    host.openOverlay(fakeOverlay("detail"));
    host.switchTo("timeline");
    expect(host.overlayOpen()).toBe(false);
  });

  it("keys and rendering go to the top overlay while one is open", () => {
    const { host } = makeHost();
    const overlay = fakeOverlay("detail");
    host.openOverlay(overlay);
    expect(host.target()).toBe(overlay);
    host.closeOverlay();
    expect(host.target()).toBe(host.screen("trace"));
  });

  it("a searched selection opens the trace and applies its query there", () => {
    const { host, log } = makeHost();
    host.switchTo("overview");
    host.openOverlay(fakeOverlay("tracePicker"));
    host.selectTrace("T2", "archiveNotes");
    expect(host.activeScreen()).toBe("trace");
    expect(host.currentTraceId()).toBe("T2");
    expect(log.filter((entry) => entry.endsWith("setTrace(T2)"))).toHaveLength(4);
    expect(log).toContain("trace.applySearch(archiveNotes)");
    expect(log).not.toContain("timeline.applySearch(archiveNotes)");
    expect(host.overlayOpen()).toBe(false);
  });

  it("stepping wraps around, and does nothing with one trace", () => {
    const { host } = makeHost();
    host.stepTrace(-1, ["T1", "T2", "T3"]);
    expect(host.currentTraceId()).toBe("T3");
    host.stepTrace(1, ["T3"]);
    expect(host.currentTraceId()).toBe("T3");
  });

  it("new data reaches every screen and every overlay", () => {
    const { host, log } = makeHost();
    host.setData([traceRoot("T1")], "T1");
    expect(log.filter((entry) => entry.endsWith(".setData"))).toHaveLength(4);
  });

  it("when the current trace is gone from the file it moves to the fallback", () => {
    const { host, log } = makeHost();
    host.setData([traceRoot("T9")], "T9");
    expect(host.currentTraceId()).toBe("T9");
    expect(log).toContain("overview.setTrace(T9)");
  });

  it("an overlay opened while following is told so", () => {
    const { host } = makeHost();
    const overlay = fakeOverlay("detail");
    host.setFollowIndicator(true);
    host.openOverlay(overlay);
    expect(overlay.following).toBe(true);
  });

  it("an overlay without an escape of its own has nothing to undo", () => {
    const { host } = makeHost();
    host.openOverlay(fakeOverlay("detail"));
    expect(host.escapeOverlay()).toBe(false);
  });
});
