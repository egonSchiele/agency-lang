import { describe, expect, it, vi } from "vitest";

import type { Screen } from "@/tui/screen.js";

import { createLabelingHost, type LabelingHostDependencies } from "./labelingHost.js";

function fakeController() {
  let closeCount = 0;
  return {
    snapshot: () => ({}) as never,
    dispatch: async () => ({}) as never,
    close: async () => { closeCount += 1; },
    closed: () => closeCount,
  };
}

const SCREEN = { destroy: vi.fn() } as unknown as Screen;
const SIZE = () => ({ width: 80, height: 24 });

function deps(over: Partial<LabelingHostDependencies> = {}) {
  return {
    openSession: vi.fn(async () => fakeController()),
    runTui: vi.fn(async () => {}),
    readFieldOrder: vi.fn(() => ["task", "output"]),
    ...over,
  } as unknown as LabelingHostDependencies;
}

const request = {
  datasetDir: "/tmp/ds",
  checklistFile: "/tmp/cl.json",
  annotator: { kind: "human", id: "adit" } as const,
  focusOutputId: "out_abc",
};

describe("labelingHost", () => {
  it("opens a session with the request, runs the TUI on the given screen, then closes", async () => {
    const controller = fakeController();
    const dependencies = deps({ openSession: vi.fn(async () => controller) as never });
    await createLabelingHost(SCREEN, SIZE, dependencies).run(request);

    expect(dependencies.openSession).toHaveBeenCalledWith(expect.objectContaining({
      storeDir: "/tmp/ds",
      checklistFile: "/tmp/cl.json",
      annotator: { kind: "human", id: "adit" },
      focusOutputId: "out_abc",
    }));
    expect(dependencies.runTui).toHaveBeenCalledWith(expect.objectContaining({
      controller,
      screen: SCREEN,
      fieldOrder: ["task", "output"],
    }));
    expect(controller.closed()).toBe(1);
  });

  it("closes the controller but never destroys the screen when the TUI throws", async () => {
    const controller = fakeController();
    const destroy = vi.fn();
    const screen = { destroy } as unknown as Screen;
    const dependencies = deps({
      openSession: vi.fn(async () => controller) as never,
      runTui: vi.fn(async () => { throw new Error("tui exploded"); }) as never,
    });
    await expect(createLabelingHost(screen, SIZE, dependencies).run(request))
      .rejects.toThrow(/tui exploded/);
    expect(controller.closed()).toBe(1);
    expect(destroy).not.toHaveBeenCalled();
  });
});
